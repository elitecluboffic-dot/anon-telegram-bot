/**
 * Anonymous Message Telegram Bot v7 - Cloudflare Workers
 * -------------------------------------------------------
 * Tambahan dari v5:
 * - BARU: sistem INBOX. Pesan anonim (teks/gambar) yang masuk ke seseorang TIDAK
 *   langsung dikirim ke chat mereka. Pesan disimpan dulu di KV (`inbox:<userId>`),
 *   dan penerima cuma dapet notifikasi ringan:
 *     "📬 Anda memiliki pesan anonim baru!
 *      💬 Klik untuk menerima 👉 /inbox"
 * - BARU: command /inbox -> mengeluarkan semua pesan yang tertunda di antrean,
 *   mengirimkannya satu per satu ke penerima (format & tombol Balas sama seperti
 *   sebelumnya), LALU mengirim notifikasi "seen" balik ke pengirim asli masing-masing
 *   pesan:
 *     "<Nama Penerima>
 *      <blockquote>isi pesan yang tadi dikirim</blockquote>
 *
 *      💬 Pesan ini ☝️ telah dilihat!"
 *   (pakai parse_mode HTML, blockquote didukung Bot API terbaru)
 * - BARU: helper pushToInbox() & removeFromInbox() buat kelola antrean.
 * - UBAH: "🗑️ Hapus pesan" sekarang menangani DUA kondisi:
 *     1) pesan masih di inbox penerima (belum dibuka /inbox) -> ditarik dari antrean,
 *        penerima gak akan pernah lihat pesan itu sama sekali.
 *     2) pesan sudah terlanjur dikirim (penerima udah buka /inbox) -> pakai
 *        deleteMessage seperti versi lama.
 *   Makanya struktur `last_sent:<userId>` sekarang punya field tambahan `delivered`
 *   (true/false) dan `msgId` (buat kasus belum delivered).
 * - Pesan konfirmasi ke pengirim setelah kirim juga berubah, dari "berhasil dikirim ✅"
 *   jadi "menunggu dilihat oleh penerima ⏳" karena pesan belum benar-benar nyampe
 *   sampai penerima buka /inbox.
 *
 * Struktur data di KV (tambahan/ubahan dari v5):
 *   inbox:<userId> -> JSON array pesan yang tertunda:
 *     [{ msgId, fromUserId, type: "text"|"photo", text, fileId?, createdAt }, ...]
 *   last_sent:<userId> -> JSON { targetUserId, msgId, delivered: false }        (belum dilihat)
 *                       atau JSON { targetUserId, messageId, delivered: true } (sudah dilihat)
 *
 * Sisanya (struktur KV lain, gift, premium, dsb.) TIDAK berubah dari v5, lihat
 * komentar-komentar terkait di bawah untuk detailnya.
 *
 * CATATAN PENTING SOAL TELEGRAM STARS - LANGGANAN vs SEKALI BAYAR:
 * - Currency HARUS "XTR" dan provider_token dikosongkan ("") untuk KEDUANYA (premium & hadiah).
 * - Premium: WAJIB isi subscription_period = 2592000 (30 hari, satu-satunya nilai yang didukung).
 * - Hadiah: JANGAN isi subscription_period sama sekali -> jadi invoice SEKALI BAYAR biasa.
 * - Wajib handle update "pre_checkout_query" -> jawab ok:true (berlaku buat kedua jenis invoice).
 * - Pembayaran masuk sebagai message.successful_payment. Bot membedakan jenis pembayaran
 *   lewat field invoice_payload:
 *     - "premium_subscription"      -> proses sebagai langganan premium
 *     - "gift:<userId>"             -> proses sebagai pembelian hadiah anonim
 * - User bisa cancel LANGGANAN (bukan hadiah, karena hadiah sekali bayar) lewat Telegram
 *   Settings > My Subscriptions, ATAU bot bisa cancel via editUserStarSubscription (/cancelpremium).
 */

/**
 * ============ TAMBAHAN v7: RESELLER GIFT ASLI TELEGRAM ============
 * - Katalog GIFT_CATALOG sekarang punya 2 field baru per item:
 *     telegramGiftId : ID gift asli Telegram (string angka). WAJIB diisi manual,
 *                       ambil dari command /listgifts (lihat di bawah). Kalau masih
 *                       null, item itu tetap jalan pakai mode LAMA (fake notif doang).
 *     realPrice      : harga asli gift itu dalam Stars menurut Telegram (juga dari
 *                       /listgifts). Dipakai buat itung profit (price - realPrice).
 * - Command BARU /listgifts (KHUSUS owner, dicek via env.OWNER_USER_ID) -> manggil
 *   getAvailableGifts, nampilin semua gift asli Telegram beserta ID & harga Stars-nya,
 *   biar gampang disalin ke GIFT_CATALOG.
 *   >>> UPDATE: sekarang tiap gift juga dikirim sebagai STIKER (pakai sendSticker +
 *       field `sticker.file_id` dari response getAvailableGifts), jadi owner bisa
 *       LIHAT WUJUD ASLI gift-nya (animasi/video sticker), bukan cuma baca ID & harga
 *       dalam bentuk teks doang. Sticker dikirim dulu, lalu pesan teks info ID/harga
 *       nyusul di bawahnya (Bot API sendSticker gak support caption).
 * - Command BARU /giftprofit (KHUSUS owner) -> nampilin total profit dari selisih
 *   harga jual vs harga asli gift, yang kepakai (bukan real-time saldo, cuma akumulasi
 *   pencatatan internal di KV `stats:giftProfit`).
 * - Di handleGiftPaymentSuccess: SETELAH pembayaran custom masuk, kalau item itu punya
 *   telegramGiftId, bot otomatis manggil sendGift() buat kirim gift ASLI ke penerima,
 *   dibayar dari SALDO BOT (bukan dari uang pembeli lagi, itu udah masuk duluan lewat
 *   invoice). Profit = price (yang dibayar user) - realPrice (biaya beli gift asli),
 *   otomatis kecatat. Kalau sendGift gagal (saldo bot kurang / gift abis / ID salah),
 *   fallback ke notifikasi fake seperti versi lama + kirim pesan error ke owner.
 * ====================================================================
 */

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Anonymous bot v7 is running.", { status: 200 });
    }

    let update;
    try {
      update = await request.json();
    } catch (e) {
      return new Response("Bad Request", { status: 400 });
    }

    try {
      if (update.pre_checkout_query) {
        await handlePreCheckout(update.pre_checkout_query, env);
      } else if (update.callback_query) {
        await handleCallback(update.callback_query, env);
      } else if (update.inline_query) {
        await handleInlineQuery(update.inline_query, env);
      } else if (update.message) {
        await handleMessage(update.message, env);
      }
    } catch (err) {
      console.error("Error handling update:", err);
    }

    return new Response("OK", { status: 200 });
  },
};

// ============ MESSAGE HANDLER ============

async function handleMessage(message, env) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = message.text || "";

  // ---- Pembayaran Stars sukses (premium bulanan ATAU pembelian hadiah anonim) ----
  if (message.successful_payment) {
    const sp = message.successful_payment;
    const payload = sp.invoice_payload || "";

    // -- Pembelian hadiah anonim (sekali bayar) --
    if (payload.startsWith("gift:")) {
      await handleGiftPaymentSuccess(userId, chatId, env);
      return;
    }

    // -- Langganan premium bulanan (pembayaran pertama ATAU re-charge otomatis) --
    const expiryDate = sp.subscription_expiration_date
      ? new Date(sp.subscription_expiration_date * 1000)
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // fallback kalau field gak ada

    await setPremium(userId, env, {
      until: expiryDate.toISOString().slice(0, 19).replace("T", " ") + " UTC",
      chargeId: sp.telegram_payment_charge_id,
    });

    const isFirst = sp.is_first_recurring !== false; // true kalau ini pembayaran pertama
    await sendMessage(
      chatId,
      isFirst
        ? "🎉 Terima kasih! Kamu sekarang Premium (langganan bulanan aktif).\n\nKetik /setcode <kode-kamu> untuk bikin link custom, misal:\n/setcode bitcoinbim\n\nLangganan akan otomatis diperpanjang tiap bulan. Ketik /cancelpremium kapan saja buat berhenti auto-renew."
        : "✅ Langganan Premium kamu berhasil diperpanjang untuk bulan berikutnya.",
      env
    );
    return;
  }

  // ---- /start ----
  if (text.startsWith("/start")) {
    const parts = text.split(" ");
    const param = parts[1];

    if (!param) {
      const profile = await getOrCreateProfile(userId, message.from, env);
      const link = buildLink(profile.code, env);
      await sendMessage(
        chatId,
        `👋 Hi ${escapeHtml(profile.name)}, ini bot pesan anonim.\n\nTautan referral-mu:\n${link}\n\nTambahkan tautan ini ke bio/deskripsi akunmu, lalu tunggu pesan anonim dari teman ❤️`,
        env,
        { reply_markup: mainMenuKeyboard() }
      );
      return;
    }

    // Deep link "?start=gift_<code>" -> langsung ke alur pilih hadiah, skip kirim pesan dulu
    const isGiftDeepLink = param.startsWith("gift_");
    const code = isGiftDeepLink ? param.slice(5) : param;

    const targetUserIdParam = await env.ANONIM_KV.get(`code:${code}`);
    if (!targetUserIdParam) {
      await sendMessage(chatId, "Link tidak valid atau sudah dicabut oleh pemiliknya.", env);
      return;
    }
    if (Number(targetUserIdParam) === userId) {
      await sendMessage(chatId, "Ini link kamu sendiri, gak bisa kirim pesan/hadiah ke diri sendiri ya.", env);
      return;
    }

    if (isGiftDeepLink) {
      await env.ANONIM_KV.put(`last_recipient:${userId}`, targetUserIdParam);
      await env.ANONIM_KV.put(`awaiting_gift_pick:${userId}`, "1", { expirationTtl: 300 });
      await sendMessage(chatId, "🎁 Pilih hadiah yang mau kamu kirim:", env, { reply_markup: giftCatalogKeyboard() });
      return;
    }

    await env.ANONIM_KV.put(`state:${userId}`, targetUserIdParam, { expirationTtl: 3600 });
    await sendMessage(chatId, "✍️ Tulis pesan anonim kamu sekarang (boleh teks atau gambar).", env);
    return;
  }

  // ---- /inbox -> keluarkan semua pesan anonim yang masih tertunda di antrean ----
  if (text === "/inbox") {
    await handleInboxCommand(chatId, userId, env);
    return;
  }

  // ---- /listgifts -> (KHUSUS owner) lihat daftar gift asli Telegram + ID & harga Stars ----
  if (text === "/listgifts") {
    if (!isOwner(userId, env)) {
      await sendMessage(chatId, "Command ini khusus owner bot.", env);
      return;
    }
    await handleListGifts(chatId, env);
    return;
  }

  // ---- /giftprofit -> (KHUSUS owner) lihat total profit dari selisih harga gift ----
  if (text === "/giftprofit") {
    if (!isOwner(userId, env)) {
      await sendMessage(chatId, "Command ini khusus owner bot.", env);
      return;
    }
    const raw = await env.ANONIM_KV.get(`stats:giftProfit`);
    const total = raw ? Number(raw) : 0;
    await sendMessage(chatId, `💰 Total profit dari selisih harga gift asli sejauh ini: ${total} Stars.`, env);
    return;
  }

  // ---- /upgrade -> kirim invoice langganan Stars ----
  if (text === "/upgrade") {
    await sendUpgradeInvoice(chatId, env);
    return;
  }

  // ---- /cancelpremium -> matikan auto-renew (tetap premium sampai periode habis) ----
  if (text === "/cancelpremium") {
    const profile = await getProfile(userId, env);
    if (!profile?.premiumChargeId) {
      await sendMessage(chatId, "Kamu belum punya langganan Premium aktif.", env);
      return;
    }
    const ok = await cancelStarSubscription(userId, profile.premiumChargeId, env);
    await sendMessage(
      chatId,
      ok
        ? `Auto-renew dimatikan. Premium kamu tetap aktif sampai ${profile.premiumUntil || "akhir periode"}, setelah itu tidak diperpanjang lagi.`
        : "Gagal membatalkan langganan. Coba lagi nanti, atau batalkan langsung lewat Telegram Settings > My Subscriptions.",
      env
    );
    return;
  }

  // ---- /setcode <kode> -> set custom link (khusus Premium) ----
  if (text.startsWith("/setcode")) {
    await handleSetCode(chatId, userId, text, env);
    return;
  }

  // ---- Buka menu kelola ----
  if (text === "Tautan pribadi saya" || text === "/mylink") {
    await sendSettingsMenu(chatId, userId, env);
    return;
  }

  // ---- Tombol menu setelah kirim pesan: kirim pesan lagi ke orang yang sama ----
  if (text === "📧 Kirim pesan lainnya") {
    const lastRecipient = await env.ANONIM_KV.get(`last_recipient:${userId}`);
    if (!lastRecipient) {
      await sendMessage(chatId, "Belum ada riwayat penerima. Buka link seseorang dulu ya buat kirim pesan anonim.", env);
      return;
    }
    await env.ANONIM_KV.put(`state:${userId}`, lastRecipient, { expirationTtl: 3600 });
    await sendMessage(chatId, "✍️ Tulis pesan anonim kamu sekarang (boleh teks atau gambar).", env);
    return;
  }

  // ---- Tombol menu: hapus pesan anonim terakhir yang dikirim ----
  if (text === "🗑️ Hapus pesan") {
    const raw = await env.ANONIM_KV.get(`last_sent:${userId}`);
    if (!raw) {
      await sendMessage(chatId, "Gak ada pesan yang bisa dihapus.", env);
      return;
    }
    const lastSent = JSON.parse(raw);

    // Kasus 1: pesan masih ngendon di inbox penerima, belum sempat dibuka /inbox
    if (!lastSent.delivered) {
      const removed = await removeFromInbox(lastSent.targetUserId, lastSent.msgId, env);
      await sendMessage(
        chatId,
        removed
          ? "🗑️ Pesan berhasil ditarik sebelum sempat dilihat penerima."
          : "Pesan sudah keburu dilihat penerima atau sudah dihapus duluan.",
        env
      );
      if (removed) await env.ANONIM_KV.delete(`last_sent:${userId}`);
      return;
    }

    // Kasus 2: pesan sudah terkirim ke chat penerima (sudah dibuka lewat /inbox)
    const ok = await deleteMessage(Number(lastSent.targetUserId), lastSent.messageId, env);
    await sendMessage(
      chatId,
      ok
        ? "🗑️ Pesan berhasil dihapus dari sisi penerima."
        : "Gagal menghapus pesan (mungkin sudah kedaluwarsa atau sudah dihapus duluan).",
      env
    );
    if (ok) await env.ANONIM_KV.delete(`last_sent:${userId}`);
    return;
  }

  // ---- Tombol menu: mulai alur kirim hadiah anonim ----
  if (text === "🎁 Kirim hadiah anonim") {
    const lastRecipient = await env.ANONIM_KV.get(`last_recipient:${userId}`);
    if (!lastRecipient) {
      await sendMessage(chatId, "Kirim pesan anonim dulu ya, baru bisa kirim hadiah ke orang itu.", env);
      return;
    }
    await env.ANONIM_KV.put(`awaiting_gift_pick:${userId}`, "1", { expirationTtl: 300 });
    await sendMessage(chatId, "🎁 Pilih hadiah yang mau kamu kirim:", env, { reply_markup: giftCatalogKeyboard() });
    return;
  }

  // ---- Sedang menunggu input kode custom (dari tombol menu) ----
  const awaitingCode = await env.ANONIM_KV.get(`awaiting_code:${userId}`);
  if (awaitingCode) {
    await env.ANONIM_KV.delete(`awaiting_code:${userId}`);
    await trySetCustomCode(chatId, userId, text, env);
    return;
  }

  // ---- Sedang memilih hadiah dari katalog ----
  const awaitingGiftPick = await env.ANONIM_KV.get(`awaiting_gift_pick:${userId}`);
  if (awaitingGiftPick) {
    if (text === "⬅️ Kembali") {
      await env.ANONIM_KV.delete(`awaiting_gift_pick:${userId}`);
      await sendMessage(chatId, "Oke, dibatalin.", env, { reply_markup: postSendKeyboard() });
      return;
    }

    const gift = findGiftByButtonLabel(text);
    if (!gift) {
      await sendMessage(chatId, "Pilih salah satu hadiah dari tombol di bawah ya.", env, {
        reply_markup: giftCatalogKeyboard(),
      });
      return;
    }

    const lastRecipient = await env.ANONIM_KV.get(`last_recipient:${userId}`);
    if (!lastRecipient) {
      await env.ANONIM_KV.delete(`awaiting_gift_pick:${userId}`);
      await sendMessage(chatId, "Riwayat penerima sudah hilang, coba kirim pesan anonim dulu ya.", env, {
        reply_markup: mainMenuKeyboard(),
      });
      return;
    }

    await env.ANONIM_KV.put(
      `pending_gift:${userId}`,
      JSON.stringify({ giftId: gift.id, targetUserId: lastRecipient, message: "" }),
      { expirationTtl: 900 }
    );
    await env.ANONIM_KV.delete(`awaiting_gift_pick:${userId}`);
    await env.ANONIM_KV.put(`awaiting_gift_message:${userId}`, "1", { expirationTtl: 900 });

    await sendMessage(chatId, gift.emoji, env);
    await sendMessage(
      chatId,
      "☝️ Ini hadiah yang kamu pilih!\nKalau mau, kamu bisa tambah pesan buat hadiahnya — atau langsung skip aja.\nMaksimal 128 karakter ya.",
      env,
      { reply_markup: giftMessageKeyboard() }
    );
    return;
  }

  // ---- Sedang isi pesan opsional buat hadiah ----
  const awaitingGiftMessage = await env.ANONIM_KV.get(`awaiting_gift_message:${userId}`);
  if (awaitingGiftMessage) {
    if (text === "⬅️ Kembali") {
      await env.ANONIM_KV.delete(`awaiting_gift_message:${userId}`);
      await env.ANONIM_KV.delete(`pending_gift:${userId}`);
      await sendMessage(chatId, "Oke, dibatalin.", env, { reply_markup: postSendKeyboard() });
      return;
    }

    const raw = await env.ANONIM_KV.get(`pending_gift:${userId}`);
    if (!raw) {
      await env.ANONIM_KV.delete(`awaiting_gift_message:${userId}`);
      await sendMessage(chatId, "Sesi hadiah sudah kedaluwarsa. Mulai lagi dari menu ya.", env, {
        reply_markup: postSendKeyboard(),
      });
      return;
    }

    let giftMessage = "";
    if (text !== "⏭️ Lewati" && text) {
      if (text.length > 128) {
        await sendMessage(chatId, "Pesannya kepanjangan, maksimal 128 karakter ya. Coba lagi.", env);
        return;
      }
      giftMessage = text;
    } else if (!text) {
      await sendMessage(chatId, "Kirim teks aja ya buat pesan hadiahnya, atau tekan Lewati.", env);
      return;
    }

    const pending = JSON.parse(raw);
    pending.message = giftMessage;
    await env.ANONIM_KV.put(`pending_gift:${userId}`, JSON.stringify(pending), { expirationTtl: 900 });
    await env.ANONIM_KV.delete(`awaiting_gift_message:${userId}`);

    const gift = giftById(pending.giftId);
    const summary =
      `🎁 Hadiah kamu siap dikirim!\n\n` +
      `Detailnya nih:\n` +
      `Penerima: orang terakhir yang Anda kirimi pesan\n` +
      `Harga Hadiah: ${gift.price}\n` +
      `Pesan Kamu: ${giftMessage || "-"}\n` +
      `Total: ${gift.price}\n\n` +
      `Langsung aja lanjut ke pembayaran ya.`;

    await sendMessage(chatId, summary, env, {
      reply_markup: {
        inline_keyboard: [[{ text: `🎉 Bayar & Kirim Hadiah ⭐${gift.price}`, callback_data: "gift:pay" }]],
      },
    });
    return;
  }

  // ---- Sedang membalas pesan anonim dari user tertentu ----
  const replyTargetId = await env.ANONIM_KV.get(`reply_state:${userId}`);
  if (replyTargetId) {
    if (message.photo && message.photo.length > 0) {
      const fileId = message.photo[message.photo.length - 1].file_id;
      const caption = message.caption ? `\n\n"${message.caption}"` : "";
      await sendPhoto(Number(replyTargetId), fileId, `💬 Ada balasan anonim!${caption}`, env, replyButton(userId));
    } else if (text) {
      await sendMessage(Number(replyTargetId), `💬 Ada balasan anonim:\n\n"${text}"`, env, replyButton(userId));
    } else {
      await sendMessage(chatId, "Jenis pesan ini belum didukung untuk balasan. Kirim teks atau gambar ya.", env);
      return;
    }
    await sendMessage(chatId, "Balasan anonim berhasil dikirim ✅", env);
    await env.ANONIM_KV.delete(`reply_state:${userId}`);
    return;
  }

  // ---- Cek apakah user sedang dalam mode kirim pesan anonim ----
  const targetUserId = await env.ANONIM_KV.get(`state:${userId}`);
  if (targetUserId) {
    const targetProfile = await getProfile(targetUserId, env);
    const settings = targetProfile?.settings || { photo: true };

    let item;
    if (message.photo && message.photo.length > 0) {
      if (!settings.photo) {
        await sendMessage(chatId, "Maaf, penerima menonaktifkan pengiriman gambar lewat link ini.", env);
        return;
      }
      const fileId = message.photo[message.photo.length - 1].file_id;
      item = {
        msgId: crypto.randomUUID(),
        fromUserId: userId,
        type: "photo",
        fileId,
        text: message.caption || "",
        createdAt: new Date().toISOString(),
      };
    } else if (text) {
      item = {
        msgId: crypto.randomUUID(),
        fromUserId: userId,
        type: "text",
        text,
        createdAt: new Date().toISOString(),
      };
    } else {
      await sendMessage(chatId, "Jenis pesan ini belum didukung. Kirim teks atau gambar ya.", env);
      return;
    }

    // simpan ke antrean inbox penerima (BELUM dikirim langsung ke chat mereka)
    await pushToInbox(targetUserId, item, env);

    await incrementReceivedCount(targetUserId, env);

    // simpan riwayat penerima terakhir (dipakai buat "Kirim pesan lainnya" & "Kirim hadiah anonim")
    await env.ANONIM_KV.put(`last_recipient:${userId}`, String(targetUserId));

    // simpan referensi pesan yang barusan dikirim (dipakai buat "Hapus pesan"),
    // delivered: false karena masih di inbox, belum benar-benar nyampe
    await env.ANONIM_KV.put(
      `last_sent:${userId}`,
      JSON.stringify({ targetUserId: String(targetUserId), msgId: item.msgId, delivered: false })
    );

    // beri tahu penerima bahwa ada pesan anonim baru menunggu di /inbox
    await sendMessage(
      Number(targetUserId),
      `📬 Anda memiliki pesan anonim baru!\n\n💬 Klik untuk menerima 👉 /inbox`,
      env
    );

    await sendMessage(
      chatId,
      "📨 Pesan berhasil dikirim, menunggu dilihat oleh penerima ⏳\n\nMau ngapain lagi?",
      env,
      { reply_markup: postSendKeyboard() }
    );
    await env.ANONIM_KV.delete(`state:${userId}`);
    return;
  }

  // ---- Default fallback ----
  await sendMessage(
    chatId,
    "Ketik /start untuk dapat link pesan anonim kamu, atau buka link dari orang lain untuk kirim pesan anonim ke mereka.",
    env
  );
}

// ============ INBOX HANDLER ============

/**
 * Dipanggil saat user ketik /inbox. Mengeluarkan semua pesan anonim yang tertunda
 * (tersimpan di KV inbox:<userId>), mengirimkannya satu per satu ke chat user ini,
 * lalu mengirim notifikasi "seen" balik ke masing-masing pengirim asli.
 */
async function handleInboxCommand(chatId, userId, env) {
  const raw = await env.ANONIM_KV.get(`inbox:${userId}`);
  const inbox = raw ? JSON.parse(raw) : [];

  if (inbox.length === 0) {
    await sendMessage(chatId, "📭 Tidak ada pesan baru di inbox kamu.", env);
    return;
  }

  const viewerProfile = await getProfile(userId, env);
  const viewerName = viewerProfile?.name || "Seseorang";

  for (const item of inbox) {
    let sendResult;
    if (item.type === "photo") {
      const caption = item.text ? `\n\n"${item.text}"` : "";
      sendResult = await sendPhoto(
        chatId,
        item.fileId,
        `📩 Kamu dapat gambar anonim baru!${caption}`,
        env,
        replyButton(item.fromUserId)
      );
    } else {
      sendResult = await sendMessage(
        chatId,
        `📩 Kamu dapat pesan anonim baru:\n\n"${item.text}"`,
        env,
        replyButton(item.fromUserId)
      );
    }

    // update referensi milik pengirim jadi "delivered", biar "Hapus pesan" versi dia
    // sekarang pakai deleteMessage beneran (bukan tarik dari antrean lagi)
    if (sendResult?.result?.message_id) {
      await env.ANONIM_KV.put(
        `last_sent:${item.fromUserId}`,
        JSON.stringify({ targetUserId: String(userId), messageId: sendResult.result.message_id, delivered: true })
      );
    }

    // beri tahu pengirim asli bahwa pesannya sudah dilihat
    const quoted = item.type === "photo" ? item.text || "[gambar]" : item.text;
    await sendMessage(
      Number(item.fromUserId),
      `<b>${escapeHtml(viewerName)}</b>\n<blockquote>${escapeHtml(quoted)}</blockquote>\n\n💬 Pesan ini ☝️ telah dilihat!`,
      env,
      { parse_mode: "HTML" }
    );
  }

  await env.ANONIM_KV.delete(`inbox:${userId}`);
}

/** Tambahkan satu pesan anonim ke antrean inbox milik targetUserId. */
async function pushToInbox(targetUserId, item, env) {
  const raw = await env.ANONIM_KV.get(`inbox:${targetUserId}`);
  const inbox = raw ? JSON.parse(raw) : [];
  inbox.push(item);
  await env.ANONIM_KV.put(`inbox:${targetUserId}`, JSON.stringify(inbox));
}

/**
 * Tarik satu pesan dari antrean inbox milik targetUserId berdasarkan msgId
 * (dipakai fitur "Hapus pesan" sebelum pesan sempat dilihat).
 * Return true kalau berhasil ketemu & dihapus, false kalau tidak ketemu
 * (kemungkinan sudah keburu dilihat / dihapus duluan).
 */
async function removeFromInbox(targetUserId, msgId, env) {
  const raw = await env.ANONIM_KV.get(`inbox:${targetUserId}`);
  if (!raw) return false;
  const inbox = JSON.parse(raw);
  const newInbox = inbox.filter((m) => m.msgId !== msgId);
  if (newInbox.length === inbox.length) return false;
  await env.ANONIM_KV.put(`inbox:${targetUserId}`, JSON.stringify(newInbox));
  return true;
}

// ============ CALLBACK (TOMBOL INLINE) HANDLER ============

async function handleCallback(cq, env) {
  const chatId = cq.message.chat.id;
  const messageId = cq.message.message_id;
  const userId = cq.from.id;
  const data = cq.data;

  await answerCallbackQuery(cq.id, env);

  if (data === "menu:settings" || data === "menu:back") {
    await editSettingsMenu(chatId, messageId, userId, env);
  } else if (data === "menu:umum") {
    await editUmumMenu(chatId, messageId, userId, env);
  } else if (data === "menu:media") {
    await editMediaMenu(chatId, messageId, userId, env);
  } else if (data === "menu:fitur") {
    await editMessageText(chatId, messageId, "🧪 Fitur tambahan belum tersedia di versi ini.", env, {
      reply_markup: backKeyboard(),
    });
  } else if (data === "toggle:photo") {
    await toggleMediaSetting(userId, "photo", env);
    await editMediaMenu(chatId, messageId, userId, env);
  } else if (data === "menu:revoke") {
    await revokeLink(userId, env);
    await editSettingsMenu(chatId, messageId, userId, env, "🔄 Tautan lama dicabut, kamu dapat tautan baru!");
  } else if (data === "menu:copy") {
    const profile = await getProfile(userId, env);
    const link = buildLink(profile.code, env);
    await answerCallbackQuery(cq.id, env, `Tautan: ${link}`, true);
  } else if (data === "menu:customlink") {
    const profile = await getProfile(userId, env);
    if (!isPremiumActive(profile)) {
      await editMessageText(
        chatId,
        messageId,
        `🔒 Custom Link adalah fitur Premium (langganan ${escapeHtml(env.PREMIUM_STARS_PRICE)} Stars/bulan).\n\nContoh: t.me/${env.BOT_USERNAME}?start=bitcoinbim\n\nKetik /upgrade untuk berlangganan pakai Telegram Stars ⭐`,
        env,
        { reply_markup: backKeyboard() }
      );
      return;
    }
    await env.ANONIM_KV.put(`awaiting_code:${userId}`, "1", { expirationTtl: 300 });
    await editMessageText(
      chatId,
      messageId,
      "✏️ Ketik kode custom yang kamu mau (huruf/angka/underscore/dash, 3-32 karakter), lalu kirim sebagai pesan biasa.",
      env,
      { reply_markup: backKeyboard() }
    );
  } else if (data === "gift:pay") {
    // ---- Konfirmasi bayar hadiah anonim -> kirim invoice Stars sekali bayar ----
    const raw = await env.ANONIM_KV.get(`pending_gift:${userId}`);
    if (!raw) {
      await sendMessage(chatId, "Sesi hadiah sudah kedaluwarsa. Mulai lagi dari menu ya.", env, {
        reply_markup: postSendKeyboard(),
      });
      return;
    }
    const pending = JSON.parse(raw);
    const gift = giftById(pending.giftId);
    if (!gift) {
      await sendMessage(chatId, "Hadiah tidak ditemukan, coba pilih ulang dari menu.", env, {
        reply_markup: postSendKeyboard(),
      });
      return;
    }
    await sendGiftInvoice(chatId, userId, gift, env);
  } else if (data.startsWith("reply:")) {
    const senderUserId = data.split(":")[1];
    // userId yang klik tombol ini (cq.from.id) mau balas ke senderUserId
    await env.ANONIM_KV.put(`reply_state:${cq.from.id}`, senderUserId, { expirationTtl: 3600 });
    await sendMessage(chatId, "✍️ Ketik balasan anonim kamu sekarang (boleh teks atau gambar).", env);
  }
}

// ============ INLINE QUERY HANDLER (fitur "📤 Bagikan") ============

/**
 * Dipanggil saat user tap tombol "📤 Bagikan" (switch_inline_query) lalu ketik apa saja
 * di kolom pencarian setelah nama bot (atau langsung, karena query boleh kosong).
 * Telegram mengirim update.inline_query, bot menjawab lewat answerInlineQuery dengan
 * daftar hasil. User pilih salah satu hasil -> Telegram kirimkan hasil itu SEBAGAI PESAN
 * ke chat yang lagi dibuka (nampak "via @NamaBot" di pesannya).
 *
 * PENTING: inline mode bot harus diaktifkan dulu lewat @BotFather -> /setinline,
 * kalau belum, update inline_query tidak akan pernah masuk ke webhook ini.
 */
async function handleInlineQuery(inlineQuery, env) {
  const userId = inlineQuery.from.id;
  const profile = await getOrCreateProfile(userId, inlineQuery.from, env);
  const link = buildLink(profile.code, env);
  const giftLink = buildLink(`gift_${profile.code}`, env);

  const results = [
    {
      type: "article",
      id: "send_message",
      title: "Kirim pesan anonim",
      description: "Kirim tautan biar orang ini bisa kirim pesan atau hadiah anonim ke kamu.",
      input_message_content: {
        message_text: `Kirimkan saya pesan anonim atau hadiah:`,
      },
      reply_markup: {
        inline_keyboard: [
          [{ text: "📧 Kirim pesan anonim", url: link }],
          [{ text: "🎁 Kirim hadiah anonim", url: giftLink }],
        ],
      },
    },
    {
      type: "article",
      id: "send_plain_link",
      title: "Kirim tautan pribadi",
      description: "Klik untuk mengirim tautan pribadimu di chat ini.",
      input_message_content: {
        message_text: link,
      },
    },
  ];

  await answerInlineQuery(inlineQuery.id, results, env);
}

async function answerInlineQuery(inlineQueryId, results, env) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/answerInlineQuery`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      inline_query_id: inlineQueryId,
      results,
      cache_time: 0,
      is_personal: true,
    }),
  });
}

// ============ MENU BUILDERS ============

function mainMenuKeyboard() {
  return { keyboard: [[{ text: "Tautan pribadi saya" }]], resize_keyboard: true };
}

/** Menu yang muncul setelah pesan anonim berhasil terkirim. */
function postSendKeyboard() {
  return {
    keyboard: [
      [{ text: "📧 Kirim pesan lainnya" }],
      [{ text: "🗑️ Hapus pesan" }],
      [{ text: "🎁 Kirim hadiah anonim" }],
    ],
    resize_keyboard: true,
  };
}

function settingsInlineKeyboard(link) {
  return {
    inline_keyboard: [
      [{ text: "⚙️ Umum", callback_data: "menu:umum" }, { text: "📎 Media", callback_data: "menu:media" }],
      [{ text: "🧪 Fitur", callback_data: "menu:fitur" }, { text: "🔗 Custom Link", callback_data: "menu:customlink" }],
      [{ text: "🔄 Cabut Tautan", callback_data: "menu:revoke" }],
      // switch_inline_query kosong -> tap tombol ini langsung buka layar "Pilih Obrolan"
      // bawaan Telegram, lalu begitu user pilih chat, hasil dari handleInlineQuery()
      // dikirim otomatis ke chat itu (nampil "via @NamaBot").
      [{ text: "📤 Bagikan", switch_inline_query: "" }, { text: "📋 Salin Tautan", callback_data: "menu:copy" }],
    ],
  };
}

function backKeyboard() {
  return { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "menu:back" }]] };
}

function mediaKeyboard(settings) {
  return {
    inline_keyboard: [
      [{ text: `📝 Teks: ✅ (selalu aktif)`, callback_data: "noop" }],
      [{ text: `🖼️ Gambar: ${settings.photo ? "✅" : "❌"}`, callback_data: "toggle:photo" }],
      [{ text: "⬅️ Kembali", callback_data: "menu:back" }],
    ],
  };
}

/**
 * Tombol "Balas" yang disisipkan di bawah pesan anonim / hadiah yang diteruskan.
 * originalSenderUserId = user yang TADI mengirim ini (disembunyikan di callback_data,
 * gak pernah ditampilkan sebagai teks ke penerima).
 */
function replyButton(originalSenderUserId) {
  return {
    reply_markup: {
      inline_keyboard: [[{ text: "💬 Balas", callback_data: `reply:${originalSenderUserId}` }]],
    },
  };
}

async function sendSettingsMenu(chatId, userId, env) {
  const profile = await getOrCreateProfile(userId, null, env);
  const link = buildLink(profile.code, env);
  const text = formatStatsText(profile, link);
  await sendMessage(chatId, text, env, { reply_markup: settingsInlineKeyboard(link) });
}

async function editSettingsMenu(chatId, messageId, userId, env, prefix = "") {
  const profile = await getProfile(userId, env);
  const link = buildLink(profile.code, env);
  const text = (prefix ? prefix + "\n\n" : "") + formatStatsText(profile, link);
  await editMessageText(chatId, messageId, text, env, { reply_markup: settingsInlineKeyboard(link) });
}

async function editUmumMenu(chatId, messageId, userId, env) {
  const profile = await getProfile(userId, env);
  const premiumActive = isPremiumActive(profile);
  const statusLine = premiumActive
    ? `⭐ Premium (aktif sampai ${profile.premiumUntil})`
    : "Gratis";
  const text = `⚙️ Umum\n\nNama: ${escapeHtml(profile.name)}\nTanggal buat: ${profile.createdAt}\nStatus: ${statusLine}`;
  await editMessageText(chatId, messageId, text, env, { reply_markup: backKeyboard() });
}

async function editMediaMenu(chatId, messageId, userId, env) {
  const profile = await getProfile(userId, env);
  const settings = profile.settings || { photo: true };
  const text = "📎 Media\n\nAtur jenis media apa saja yang boleh dikirim orang lain lewat tautanmu.";
  await editMessageText(chatId, messageId, text, env, { reply_markup: mediaKeyboard(settings) });
}

function formatStatsText(profile, link) {
  const premiumActive = isPremiumActive(profile);
  return (
    `💬 Kelola tautanmu di sini.\n\n` +
    `👤 Nama: ${escapeHtml(profile.name)}\n` +
    `${premiumActive ? `⭐ Status: Premium (sampai ${profile.premiumUntil})\n` : ""}` +
    `🔢 Jumlah pesan diterima: ${profile.receivedCount || 0}\n` +
    `🎁 Jumlah hadiah diterima: ${profile.receivedGifts || 0}\n` +
    `📅 Tanggal pembuatan tautan: ${profile.createdAt}\n` +
    `🔗 Tautan: ${link}`
  );
}

/** Premium dianggap aktif kalau ada tanggal expiry dan belum lewat. */
function isPremiumActive(profile) {
  if (!profile?.premiumUntil) return false;
  return new Date(profile.premiumUntil.replace(" UTC", "Z").replace(" ", "T")) > new Date();
}

// ============ KATALOG HADIAH ANONIM ============

/**
 * Katalog hadiah statis. Harga dalam Stars (XTR), sesuai contoh referensi.
 * Tambah/ubah item di sini kalau mau custom katalognya.
 */
const GIFT_CATALOG = [
  // telegramGiftId & realPrice: isi manual pakai hasil /listgifts kalau mau item ini
  // dikirim sebagai gift ASLI Telegram (bukan cuma notif fake). Biarin null kalau
  // mau tetep pakai mode lama (fake notif doang, gak ada gift asli terkirim).
  { id: "heart", emoji: "💝", label: "Hati & Pita", price: 45, telegramGiftId: null, realPrice: null },
  { id: "box", emoji: "🎁", label: "Kado", price: 75, telegramGiftId: null, realPrice: null },
  { id: "rose", emoji: "🌹", label: "Mawar", price: 75, telegramGiftId: null, realPrice: null },
  { id: "cake", emoji: "🎂", label: "Kue Ulang Tahun", price: 150, telegramGiftId: null, realPrice: null },
  { id: "bouquet", emoji: "💐", label: "Buket Bunga", price: 150, telegramGiftId: null, realPrice: null },
  { id: "rocket", emoji: "🚀", label: "Roket", price: 150, telegramGiftId: null, realPrice: null },
  { id: "champagne", emoji: "🍾", label: "Sampanye", price: 150, telegramGiftId: null, realPrice: null },
  { id: "trophy", emoji: "🏆", label: "Piala", price: 300, telegramGiftId: null, realPrice: null },
  { id: "ring", emoji: "💍", label: "Cincin", price: 300, telegramGiftId: null, realPrice: null },
  { id: "diamond", emoji: "💎", label: "Berlian", price: 300, telegramGiftId: null, realPrice: null },
];

function giftById(id) {
  return GIFT_CATALOG.find((g) => g.id === id);
}

function giftButtonLabel(g) {
  return `${g.emoji} ${g.price}`;
}

function findGiftByButtonLabel(text) {
  if (!text) return null;
  return GIFT_CATALOG.find((g) => giftButtonLabel(g) === text.trim());
}

/** Reply keyboard grid 3 kolom buat milih hadiah, plus tombol Kembali. */
function giftCatalogKeyboard() {
  const rows = [];
  for (let i = 0; i < GIFT_CATALOG.length; i += 3) {
    rows.push(GIFT_CATALOG.slice(i, i + 3).map((g) => ({ text: giftButtonLabel(g) })));
  }
  rows.push([{ text: "⬅️ Kembali" }]);
  return { keyboard: rows, resize_keyboard: true };
}

/** Keyboard buat step "tambah pesan opsional buat hadiah". */
function giftMessageKeyboard() {
  return { keyboard: [[{ text: "⏭️ Lewati" }], [{ text: "⬅️ Kembali" }]], resize_keyboard: true };
}

// ============ CUSTOM LINK (PREMIUM) ============

async function handleSetCode(chatId, userId, text, env) {
  const parts = text.split(" ");
  const desired = parts[1];
  if (!desired) {
    await sendMessage(chatId, "Format: /setcode kode-kamu\nContoh: /setcode bitcoinbim", env);
    return;
  }
  await trySetCustomCode(chatId, userId, desired, env);
}

async function trySetCustomCode(chatId, userId, desiredRaw, env) {
  const profile = await getProfile(userId, env);
  if (!profile) {
    await sendMessage(chatId, "Ketik /start dulu ya sebelum atur link.", env);
    return;
  }
  if (!isPremiumActive(profile)) {
    await sendMessage(chatId, "Custom link cuma buat Premium. Ketik /upgrade buat berlangganan pakai Telegram Stars ⭐", env);
    return;
  }

  const desired = desiredRaw.trim();
  const valid = /^[a-zA-Z0-9_-]{3,32}$/.test(desired);
  if (!valid) {
    await sendMessage(
      chatId,
      "Kode tidak valid. Gunakan huruf/angka/underscore/dash, panjang 3-32 karakter, tanpa spasi.",
      env
    );
    return;
  }

  const existingOwner = await env.ANONIM_KV.get(`code:${desired}`);
  if (existingOwner && Number(existingOwner) !== userId) {
    await sendMessage(chatId, "Yah, kode itu sudah dipakai orang lain. Coba kode lain ya.", env);
    return;
  }

  // Hapus mapping kode lama punya user ini, pasang kode baru
  await env.ANONIM_KV.delete(`code:${profile.code}`);
  profile.code = desired;
  await env.ANONIM_KV.put(`user:${userId}`, JSON.stringify(profile));
  await env.ANONIM_KV.put(`code:${desired}`, String(userId));

  const link = buildLink(desired, env);
  await sendMessage(chatId, `✅ Link custom berhasil diset!\n\n${link}`, env);
}

// ============ TELEGRAM STARS PAYMENT ============

const SUBSCRIPTION_PERIOD_SECONDS = 2592000; // 30 hari - satu-satunya nilai yang didukung Telegram saat ini

async function sendUpgradeInvoice(chatId, env) {
  const price = Number(env.PREMIUM_STARS_PRICE || "50");
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendInvoice`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      title: "Anomessbot Premium",
      description: `Langganan bulanan ${price} Stars: buka fitur link custom (mis. t.me/${env.BOT_USERNAME}?start=usernamekamu) & fitur premium lainnya. Auto-renew tiap bulan, bisa dibatalkan kapan saja.`,
      payload: "premium_subscription",
      currency: "XTR", // WAJIB "XTR" untuk Telegram Stars
      prices: [{ label: "Premium / bulan", amount: price }], // amount = jumlah Stars, tanpa desimal
      provider_token: "", // WAJIB dikosongkan untuk Stars
      subscription_period: SUBSCRIPTION_PERIOD_SECONDS, // bikin ini invoice LANGGANAN, bukan sekali bayar
    }),
  });
}

/**
 * Invoice buat beli hadiah anonim. SEKALI BAYAR -> subscription_period TIDAK diisi.
 * payload dibikin "gift:<userId>" (bukan JSON) supaya tetap di bawah batas panjang payload
 * Telegram walau pesan hadiahnya panjang; detail lengkap (gift id, target, pesan) diambil
 * lagi dari KV pending_gift:<userId> pas successful_payment masuk.
 */
async function sendGiftInvoice(chatId, userId, gift, env) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendInvoice`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      title: `Hadiah Anonim: ${gift.emoji} ${gift.label}`,
      description: `Kirim hadiah "${gift.label}" secara anonim ke orang terakhir yang kamu kirimi pesan.`,
      payload: `gift:${userId}`,
      currency: "XTR", // WAJIB "XTR" untuk Telegram Stars
      prices: [{ label: gift.label, amount: gift.price }],
      provider_token: "", // WAJIB dikosongkan untuk Stars
      // TIDAK ada subscription_period di sini -> jadi invoice sekali bayar biasa
    }),
  });
}

async function handlePreCheckout(pcq, env) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/answerPreCheckoutQuery`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pre_checkout_query_id: pcq.id, ok: true }),
  });
}

/** value = { until: "YYYY-MM-DD HH:MM:SS UTC", chargeId: "..." } */
async function setPremium(userId, env, value) {
  const profile = await getProfile(userId, env);
  if (!profile) return;
  profile.premium = true;
  profile.premiumUntil = value.until;
  profile.premiumChargeId = value.chargeId;
  await env.ANONIM_KV.put(`user:${userId}`, JSON.stringify(profile));
}

/** Matikan auto-renew lewat Telegram Bot API. User tetap premium sampai periode berjalan habis. */
async function cancelStarSubscription(userId, chargeId, env) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/editUserStarSubscription`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, telegram_payment_charge_id: chargeId, is_canceled: true }),
  });
  const data = await res.json().catch(() => ({ ok: false }));
  return !!data.ok;
}

/**
 * Dipanggil setelah pembayaran hadiah anonim sukses (invoice_payload "gift:<userId>").
 * Ambil detail hadiah dari KV pending_gift, kirim ke target, lalu bersihkan state.
 */
async function handleGiftPaymentSuccess(userId, chatId, env) {
  const raw = await env.ANONIM_KV.get(`pending_gift:${userId}`);
  if (!raw) {
    await sendMessage(
      chatId,
      "Pembayaran diterima, tapi detail hadiahnya sudah kedaluwarsa. Kalau perlu bantuan, hubungi admin.",
      env,
      { reply_markup: postSendKeyboard() }
    );
    return;
  }

  const pending = JSON.parse(raw);
  const gift = giftById(pending.giftId);
  const targetUserId = Number(pending.targetUserId);

  if (!gift || !targetUserId) {
    await sendMessage(chatId, "Pembayaran diterima, tapi data hadiah tidak lengkap. Hubungi admin ya.", env, {
      reply_markup: postSendKeyboard(),
    });
    await env.ANONIM_KV.delete(`pending_gift:${userId}`);
    return;
  }

  // Kalau item ini dikonfigurasi punya gift ASLI Telegram, coba kirim itu dulu.
  // Kalau berhasil: penerima dapet gift beneran yang nempel di profilnya, dan
  // selisih (harga jual - harga asli) kecatat sebagai profit.
  let realGiftSent = false;
  if (gift.telegramGiftId) {
    realGiftSent = await sendRealGift(targetUserId, gift.telegramGiftId, pending.message, env);
    if (realGiftSent) {
      const profit = gift.price - (gift.realPrice || 0);
      await addGiftProfit(profit, env);
    } else if (isOwnerConfigured(env)) {
      await sendMessage(
        Number(env.OWNER_USER_ID),
        `⚠️ Gagal kirim gift asli (${gift.emoji} ${gift.label}, telegramGiftId: ${gift.telegramGiftId}) ke user ${targetUserId}. Kemungkinan saldo bot kurang atau gift sudah habis. Fallback ke notif fake dulu, cek manual ya.`,
        env
      );
    }
  }

  // Fallback (atau memang item ini belum dikonfigurasi gift asli): kirim notif fake seperti versi lama.
  if (!realGiftSent) {
    const caption =
      `🎁 Kamu dapat hadiah anonim: ${gift.emoji} ${gift.label}!` +
      (pending.message ? `\n\nPesan: "${escapeHtml(pending.message)}"` : "");
    await sendMessage(targetUserId, caption, env, replyButton(userId));
  }

  await incrementGiftCount(targetUserId, env);
  await env.ANONIM_KV.delete(`pending_gift:${userId}`);
  await sendMessage(chatId, "🎉 Hadiah berhasil dikirim secara anonim!", env, { reply_markup: postSendKeyboard() });
}

/** Nambahin nilai (bisa negatif) ke akumulasi profit gift di KV. */
async function addGiftProfit(amount, env) {
  const raw = await env.ANONIM_KV.get(`stats:giftProfit`);
  const current = raw ? Number(raw) : 0;
  await env.ANONIM_KV.put(`stats:giftProfit`, String(current + amount));
}

/** Cek apakah userId ini owner bot (dibandingkan ke env.OWNER_USER_ID). */
function isOwner(userId, env) {
  return isOwnerConfigured(env) && String(userId) === String(env.OWNER_USER_ID);
}

function isOwnerConfigured(env) {
  return !!env.OWNER_USER_ID;
}

/**
 * Kirim gift ASLI Telegram ke targetUserId, dibayar dari saldo Stars bot.
 * text (pesan opsional dari pengirim anonim) ikut ditampilkan di gift-nya kalau ada,
 * dipotong ke 128 karakter sesuai batas Bot API.
 * Return true kalau sukses, false kalau gagal (owner perlu cek manual).
 */
async function sendRealGift(targetUserId, telegramGiftId, text, env) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendGift`;
  const body = {
    user_id: targetUserId,
    gift_id: telegramGiftId,
  };
  if (text) {
    body.text = text.slice(0, 128);
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({ ok: false }));
    return !!data.ok;
  } catch (e) {
    return false;
  }
}

/**
 * Command /listgifts (khusus owner): ambil daftar gift asli Telegram yang lagi
 * tersedia beserta ID & harga Stars-nya, biar gampang disalin ke GIFT_CATALOG.
 *
 * UPDATE: sekarang tiap gift juga dikirim sebagai STIKER (pakai file_id dari
 * field `sticker` di response getAvailableGifts), jadi owner bisa LIHAT WUJUD
 * ASLI gift-nya, bukan cuma baca ID & harga sebagai teks. Sticker dikirim
 * duluan, disusul pesan teks info ID/harga (sendSticker gak support caption).
 */
async function handleListGifts(chatId, env) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/getAvailableGifts`;
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const data = await res.json().catch(() => ({ ok: false }));

  if (!data.ok || !data.result?.gifts?.length) {
    await sendMessage(chatId, "Gagal ambil daftar gift dari Telegram, atau memang lagi kosong.", env);
    return;
  }

  await sendMessage(chatId, `🎁 Ditemukan ${data.result.gifts.length} gift. Mengirim satu per satu beserta stikernya...`, env);

  // DEBUG: tampilkan mentahan gift pertama biar kelihatan field apa aja yang
  // sebenernya dikembalikan Telegram (membantu kalau nama field beda dari dugaan).
  if (data.result.gifts[0]) {
    const rawPreview = JSON.stringify(data.result.gifts[0], null, 2).slice(0, 1200);
    await sendMessage(chatId, `🔍 DEBUG - struktur gift pertama dari API:\n\n${rawPreview}`, env);
  }

  for (const g of data.result.gifts) {
    const limited = g.total_count ? ` (limited: ${g.remaining_count ?? "?"}/${g.total_count})` : "";
    const caption = `ID: ${g.id} — ${g.star_count} Stars${limited}`;

    // Kirim wujud visual gift-nya dulu (kalau field sticker ada)
    if (g.sticker?.file_id) {
      const stickerResult = await sendSticker(chatId, g.sticker.file_id, env);
      if (!stickerResult?.ok) {
        await sendMessage(
          chatId,
          `⚠️ Gagal kirim stiker gift ID ${g.id}. Error dari Telegram: ${stickerResult?.description || "(tidak ada deskripsi, cek koneksi/response)"}`,
          env
        );
      }
    } else {
      await sendMessage(chatId, `⚠️ Gift ID ${g.id} tidak punya field "sticker.file_id" di response API.`, env);
    }
    // Baru info ID & harga sebagai teks (sendSticker gak support caption)
    await sendMessage(chatId, caption, env);
  }

  await sendMessage(
    chatId,
    "Salin ID & harga Stars yang kamu mau ke GIFT_CATALOG (field telegramGiftId & realPrice), cocokkan sama emoji/label yang paling mirip ya.",
    env
  );
}

// ============ DATA HELPERS (KV) ============

async function getProfile(userId, env) {
  const raw = await env.ANONIM_KV.get(`user:${userId}`);
  return raw ? JSON.parse(raw) : null;
}

async function getOrCreateProfile(userId, fromUser, env) {
  let profile = await getProfile(userId, env);
  if (profile) return profile;

  const code = generateCode();
  const name = fromUser?.first_name || fromUser?.username || "Anonymous";
  profile = {
    code,
    name,
    createdAt: new Date().toISOString().slice(0, 19).replace("T", " ") + " UTC",
    receivedCount: 0,
    receivedGifts: 0,
    premium: false,
    premiumUntil: null,
    premiumChargeId: null,
    settings: { photo: true },
  };
  await env.ANONIM_KV.put(`user:${userId}`, JSON.stringify(profile));
  await env.ANONIM_KV.put(`code:${code}`, String(userId));
  return profile;
}

async function toggleMediaSetting(userId, key, env) {
  const profile = await getProfile(userId, env);
  if (!profile) return;
  profile.settings = profile.settings || {};
  profile.settings[key] = !profile.settings[key];
  await env.ANONIM_KV.put(`user:${userId}`, JSON.stringify(profile));
}

async function incrementReceivedCount(userId, env) {
  const profile = await getProfile(userId, env);
  if (!profile) return;
  profile.receivedCount = (profile.receivedCount || 0) + 1;
  await env.ANONIM_KV.put(`user:${userId}`, JSON.stringify(profile));
}

async function incrementGiftCount(userId, env) {
  const profile = await getProfile(userId, env);
  if (!profile) return;
  profile.receivedGifts = (profile.receivedGifts || 0) + 1;
  await env.ANONIM_KV.put(`user:${userId}`, JSON.stringify(profile));
}

async function revokeLink(userId, env) {
  const profile = await getProfile(userId, env);
  if (!profile) return;
  await env.ANONIM_KV.delete(`code:${profile.code}`);
  const newCode = generateCode();
  profile.code = newCode;
  await env.ANONIM_KV.put(`user:${userId}`, JSON.stringify(profile));
  await env.ANONIM_KV.put(`code:${newCode}`, String(userId));
}

function buildLink(code, env) {
  return `https://t.me/${env.BOT_USERNAME}?start=${code}`;
}

function generateCode(length = 8) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

// ============ TELEGRAM API HELPERS ============

async function sendMessage(chatId, text, env, extra = {}) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, ...extra }),
  });
  return res.json().catch(() => null);
}

async function sendPhoto(chatId, fileId, caption, env, extra = {}) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendPhoto`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, photo: fileId, caption, ...extra }),
  });
  return res.json().catch(() => null);
}

/**
 * BARU (v7 update): kirim stiker (dipakai buat preview visual gift asli Telegram
 * di /listgifts, lewat file_id dari field `sticker` pada response getAvailableGifts).
 */
async function sendSticker(chatId, fileId, env, extra = {}) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendSticker`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, sticker: fileId, ...extra }),
  });
  return res.json().catch(() => null);
}

async function editMessageText(chatId, messageId, text, env, extra = {}) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/editMessageText`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, ...extra }),
  });
}

async function deleteMessage(chatId, messageId, env) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/deleteMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
  });
  const data = await res.json().catch(() => ({ ok: false }));
  return !!data.ok;
}

async function answerCallbackQuery(callbackQueryId, env, text, showAlert = false) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: showAlert }),
  });
}
