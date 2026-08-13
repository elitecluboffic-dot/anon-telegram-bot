/**
 * Anonymous Message Telegram Bot v8 - Cloudflare Workers
 * -------------------------------------------------------
 * TAMBAHAN dari v7 (fokus perubahan versi ini):
 * - BARU: dukungan MEDIA LENGKAP. Sebelumnya cuma teks & gambar yang bisa
 *   dikirim/diatur, sekarang mendukung: Gambar, GIF/Foto Bergerak, Stiker,
 *   Video, Pesan video (video bulat), Musik (audio), Suara (voice note),
 *   Dokumen, Kontak, dan Lokasi.
 * - Menu "📎 Media" sekarang generate tombol toggle-nya otomatis dari daftar
 *   MEDIA_TYPES, jadi tinggal tambah 1 baris di situ kalau suatu saat mau
 *   nambah jenis media baru lagi.
 * - CATATAN PENTING: "Foto Bergerak" dan "GIF" DIGABUNG jadi satu setting
 *   (`animation`). Ini bukan bug - di Telegram Bot API, GIF dan "moving
 *   photo" itu SAMA PERSIS objeknya (field `message.animation`), gak ada
 *   cara buat bot membedakan keduanya. Jadi satu toggle ngatur keduanya
 *   sekaligus, biar gak ada toggle "palsu" yang keliatan beda padahal
 *   fungsinya identik.
 * - Profil lama (dibuat sebelum v8) otomatis di-merge ke default settings
 *   baru saat dibaca (lihat `defaultMediaSettings()` + merge di beberapa
 *   tempat), jadi gak perlu migrasi data manual di KV.
 * - Keterbatasan yang perlu diketahui: untuk tipe media yang TIDAK mendukung
 *   caption di Bot API (stiker, pesan video, kontak, lokasi), bot mengirim
 *   teks notifikasi "Kamu dapat ... anonim baru!" sebagai PESAN TERPISAH
 *   sebelum media itu sendiri. Konsekuensinya, tombol "🗑️ Hapus pesan" cuma
 *   akan menghapus pesan medianya, teks notifikasi terpisah itu tetap ada
 *   di chat penerima.
 *
 * Semua fitur v7 (inbox, hadiah anonim/gift asli Telegram, premium & custom
 * link, statistik, dsb.) TIDAK berubah - lihat komentar-komentar terkait di
 * bawah untuk detailnya.
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
 * ============ RESELLER GIFT ASLI TELEGRAM (dari v7, tidak berubah) ============
 * - Katalog GIFT_CATALOG punya 2 field per item:
 *     telegramGiftId : ID gift asli Telegram (string angka), diambil dari /listgifts.
 *     realPrice      : harga asli gift itu dalam Stars menurut Telegram.
 * - /listgifts (KHUSUS owner) -> nampilin semua gift asli Telegram + preview stiker
 *   asli + ID & harga Stars-nya.
 * - /giftprofit (KHUSUS owner) -> total profit dari selisih harga jual vs harga asli.
 * - Di handleGiftPaymentSuccess: kalau item punya telegramGiftId, bot kirim gift ASLI
 *   (dibayar dari saldo bot), profit tercatat otomatis. Kalau gagal, fallback ke
 *   notifikasi fake + pesan error ke owner.
 * ====================================================================
 */

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Anonymous bot v8 is running.", { status: 200 });
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

// ============ KONFIGURASI JENIS MEDIA ============

/**
 * Daftar semua jenis media (di luar teks, yang selalu aktif) yang bisa
 * dikirim lewat tautan anonim & diatur nyala/matinya lewat menu Media.
 * `key`   -> dipakai sebagai nama field di profile.settings & callback_data toggle.
 * `label` -> teks yang tampil di tombol menu Media.
 * `noun`  -> kata benda buat notifikasi ("Kamu dapat <noun> anonim baru!").
 */
const MEDIA_TYPES = [
  { key: "photo", label: "🖼️ Gambar", noun: "gambar" },
  { key: "animation", label: "🎞️ GIF / Foto Bergerak", noun: "GIF/foto bergerak" },
  { key: "sticker", label: "😊 Stiker", noun: "stiker" },
  { key: "video", label: "🎥 Video", noun: "video" },
  { key: "video_note", label: "📹 Pesan video", noun: "pesan video" },
  { key: "audio", label: "🎵 Musik", noun: "musik" },
  { key: "voice", label: "🎤 Suara", noun: "pesan suara" },
  { key: "document", label: "📄 Dokumen", noun: "dokumen" },
  { key: "contact", label: "📞 Kontak", noun: "kontak" },
  { key: "location", label: "📍 Lokasi", noun: "lokasi" },
];

/** Tipe yang didukung Telegram Bot API buat pakai caption (teks nempel di medianya). */
const CAPTIONABLE_TYPES = new Set(["photo", "animation", "video", "audio", "voice", "document"]);

/** Settings default: semua jenis media aktif (true) untuk profil baru. */
function defaultMediaSettings() {
  const s = {};
  for (const m of MEDIA_TYPES) s[m.key] = true;
  return s;
}

/** Gabungkan settings tersimpan dengan default, biar profil lama (pre-v8) otomatis lengkap. */
function resolveMediaSettings(profile) {
  return { ...defaultMediaSettings(), ...(profile?.settings || {}) };
}

function mediaTypeNoun(type) {
  const found = MEDIA_TYPES.find((m) => m.key === type);
  return found ? found.noun : "pesan";
}

// ============ MESSAGE HANDLER ============

async function handleMessage(message, env) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = message.text || "";

  // catat "penggunaan" bot (dipakai buat /statistik) + pastikan launch date sudah tercatat
  await incrementCounter(`stats:totalUses`, env);
  await ensureLaunchDate(env);

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
    await sendMessage(
      chatId,
      "✍️ Tulis pesan anonim kamu sekarang (boleh teks, gambar, GIF, stiker, video, pesan video, musik, suara, dokumen, kontak, atau lokasi).",
      env
    );
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

  // ---- /tentang -> halaman "Tentang" bot + kredit pembuat (mention otomatis dari ID) ----
  if (text === "/tentang" || text === "/about") {
    await handleTentangCommand(chatId, env);
    return;
  }

  // ---- /statistik -> statistik bot REAL, diambil dari counter di KV ----
  if (text === "/statistik" || text === "/stats") {
    await handleStatistikCommand(chatId, env);
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
    await sendMessage(
      chatId,
      "✍️ Tulis pesan anonim kamu sekarang (boleh teks, gambar, GIF, stiker, video, pesan video, musik, suara, dokumen, kontak, atau lokasi).",
      env
    );
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
    const extracted = extractItemFromMessage(message);
    if (!extracted) {
      await sendMessage(chatId, "Jenis pesan ini belum didukung untuk balasan.", env);
      return;
    }
    const prefixText =
      extracted.type === "text"
        ? `💬 Ada balasan anonim:\n\n"${extracted.text}"`
        : `💬 Ada balasan anonim (${mediaTypeNoun(extracted.type)})!`;
    await sendMediaItem(Number(replyTargetId), extracted, prefixText, env, replyButton(userId));
    await sendMessage(chatId, "Balasan anonim berhasil dikirim ✅", env);
    await env.ANONIM_KV.delete(`reply_state:${userId}`);
    return;
  }

  // ---- Cek apakah user sedang dalam mode kirim pesan anonim ----
  const targetUserId = await env.ANONIM_KV.get(`state:${userId}`);
  if (targetUserId) {
    const targetProfile = await getProfile(targetUserId, env);
    const settings = resolveMediaSettings(targetProfile);

    const extracted = extractItemFromMessage(message);
    if (!extracted) {
      await sendMessage(
        chatId,
        "Jenis pesan ini belum didukung. Coba kirim teks, gambar, GIF, stiker, video, pesan video, musik, suara, dokumen, kontak, atau lokasi.",
        env
      );
      return;
    }

    if (extracted.type !== "text" && settings[extracted.type] === false) {
      await sendMessage(chatId, `Maaf, penerima menonaktifkan pengiriman ${mediaTypeNoun(extracted.type)} lewat link ini.`, env);
      return;
    }

    const item = {
      msgId: crypto.randomUUID(),
      fromUserId: userId,
      createdAt: new Date().toISOString(),
      ...extracted,
    };

    // simpan ke antrean inbox penerima (BELUM dikirim langsung ke chat mereka)
    await pushToInbox(targetUserId, item, env);

    // catat "jumlah pesan" global (dipakai buat /statistik)
    await incrementCounter(`stats:totalMessages`, env);

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

// ============ EKSTRAKSI & PENGIRIMAN MEDIA (generik untuk semua jenis) ============

/**
 * Baca pesan Telegram masuk (message.photo / .animation / .sticker / dst) dan
 * ubah jadi objek item internal { type, fileId?, text?, contact?, location? }.
 * Return null kalau jenis pesannya gak didukung sama sekali (mis. poll, dice).
 */
function extractItemFromMessage(message) {
  const text = message.text || "";

  if (message.photo && message.photo.length > 0) {
    return { type: "photo", fileId: message.photo[message.photo.length - 1].file_id, text: message.caption || "" };
  }
  if (message.animation) {
    return { type: "animation", fileId: message.animation.file_id, text: message.caption || "" };
  }
  if (message.sticker) {
    return { type: "sticker", fileId: message.sticker.file_id, text: "" };
  }
  if (message.video) {
    return { type: "video", fileId: message.video.file_id, text: message.caption || "" };
  }
  if (message.video_note) {
    return { type: "video_note", fileId: message.video_note.file_id, text: "" };
  }
  if (message.audio) {
    return { type: "audio", fileId: message.audio.file_id, text: message.caption || "" };
  }
  if (message.voice) {
    return { type: "voice", fileId: message.voice.file_id, text: message.caption || "" };
  }
  if (message.document) {
    return { type: "document", fileId: message.document.file_id, text: message.caption || "" };
  }
  if (message.contact) {
    return {
      type: "contact",
      text: "",
      contact: {
        phone_number: message.contact.phone_number,
        first_name: message.contact.first_name || "Kontak",
        last_name: message.contact.last_name || "",
      },
    };
  }
  if (message.location) {
    return {
      type: "location",
      text: "",
      location: { latitude: message.location.latitude, longitude: message.location.longitude },
    };
  }
  if (text) {
    return { type: "text", text };
  }
  return null;
}

/**
 * Kirim satu item (hasil extractItemFromMessage / disimpan di inbox) ke chatId,
 * pakai endpoint Telegram yang sesuai jenisnya.
 * - Untuk tipe yang mendukung caption (foto/gif/video/audio/voice/dokumen):
 *   prefixText digabung jadi caption di media itu sendiri.
 * - Untuk tipe yang TIDAK mendukung caption (stiker/pesan video/kontak/lokasi):
 *   prefixText dikirim dulu sebagai pesan teks terpisah, baru medianya.
 * - Untuk teks biasa: langsung dikirim sebagai pesan teks (prefixText = isi lengkap).
 * Return hasil call terakhir (dipakai buat ambil message_id media, kalau ada).
 */
async function sendMediaItem(chatId, item, prefixText, env, extra = {}) {
  if (item.type === "text") {
    return sendMessage(chatId, prefixText, env, extra);
  }

  if (CAPTIONABLE_TYPES.has(item.type)) {
    const caption = prefixText + (item.text ? `\n\n"${item.text}"` : "");
    switch (item.type) {
      case "photo":
        return sendPhoto(chatId, item.fileId, caption, env, extra);
      case "animation":
        return sendAnimation(chatId, item.fileId, caption, env, extra);
      case "video":
        return sendVideo(chatId, item.fileId, caption, env, extra);
      case "audio":
        return sendAudio(chatId, item.fileId, caption, env, extra);
      case "voice":
        return sendVoice(chatId, item.fileId, caption, env, extra);
      case "document":
        return sendDocument(chatId, item.fileId, caption, env, extra);
    }
  }

  // Tipe tanpa dukungan caption: kirim teks notifikasi dulu, baru medianya.
  await sendMessage(chatId, prefixText, env);
  switch (item.type) {
    case "sticker":
      return sendSticker(chatId, item.fileId, env, extra);
    case "video_note":
      return sendVideoNote(chatId, item.fileId, env, extra);
    case "contact":
      return sendContact(chatId, item.contact, env, extra);
    case "location":
      return sendLocation(chatId, item.location, env, extra);
  }
  return null;
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
    const prefixText =
      item.type === "text"
        ? `📩 Kamu dapat pesan anonim baru:\n\n"${item.text}"`
        : `📩 Kamu dapat ${mediaTypeNoun(item.type)} anonim baru!`;

    const sendResult = await sendMediaItem(chatId, item, prefixText, env, replyButton(item.fromUserId));

    // update referensi milik pengirim jadi "delivered", biar "Hapus pesan" versi dia
    // sekarang pakai deleteMessage beneran (bukan tarik dari antrean lagi)
    if (sendResult?.result?.message_id) {
      await env.ANONIM_KV.put(
        `last_sent:${item.fromUserId}`,
        JSON.stringify({ targetUserId: String(userId), messageId: sendResult.result.message_id, delivered: true })
      );
    }

    // beri tahu pengirim asli bahwa pesannya sudah dilihat
    const quoted = item.type === "text" ? item.text : item.text || `[${mediaTypeNoun(item.type)}]`;
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

// ============ HALAMAN "TENTANG" ============

/**
 * /tentang (alias /about) - Tampilkan deskripsi panjang soal bot + baris kredit
 * pembuat. Kredit dibangun otomatis dari env.OWNER_USER_ID (angka ID Telegram),
 * BUKAN username yang diketik manual di kode - jadi walau owner ganti username
 * Telegram-nya kapan saja, kredit di /tentang tetap otomatis ikut update karena
 * diambil LIVE lewat getChat tiap kali command ini dipanggil.
 */
async function handleTentangCommand(chatId, env) {
  const creditLine = await buildOwnerCreditHtml(env);

  const text =
    `🕶️ <b>Tentang Bot</b>\n\n` +
    `Di balik setiap tautan yang kamu bagikan, ada ruang aman untuk jujur tanpa harus menunjukkan wajah.\n\n` +
    `Bot ini dibangun buat satu alasan sederhana: kadang kata-kata paling jujur cuma bisa keluar kalau identitas gak jadi taruhan. Entah itu pujian yang malu-malu, kritik yang selama ini dipendam, curahan hati tengah malam, atau sekadar "hai" dari seseorang yang gak berani bilang langsung — semua bisa tersampaikan lewat sini, tanpa jejak, tanpa rasa takut dihakimi.\n\n` +
    `✨ <b>Kenapa banyak yang pakai:</b>\n` +
    `• ⚡ <b>Cepat</b> — pesan sampai dalam hitungan detik, tanpa ribet.\n` +
    `• 🔒 <b>Aman</b> — identitas pengirim gak pernah ditampilkan ke penerima, titik.\n` +
    `• 📎 <b>Media Lengkap</b> — gambar, GIF, stiker, video, musik, suara, dokumen, kontak, sampai lokasi.\n` +
    `• 📬 <b>Sistem Inbox</b> — kamu yang menentukan kapan sebuah pesan dibuka & "dilihat".\n` +
    `• 🎁 <b>Hadiah Anonim</b> — kirim gift asli Telegram tanpa ketahuan siapa pengirimnya.\n` +
    `• 🔗 <b>Tautan Custom</b> — biar link kamu gampang diingat & keliatan profesional (fitur Premium).\n\n` +
    `Semua dibangun ringan & cepat di atas Cloudflare Workers, jadi kapan pun link kamu dibuka, bot selalu siap sedia.\n\n` +
    `Ketik /start buat dapetin tautan pribadimu sendiri, atau /mylink buat kelola pengaturan.\n\n` +
    `🛠️ <b>Dibangun oleh:</b> ${creditLine}`;

  await sendMessage(chatId, text, env, { parse_mode: "HTML" });
}

/**
 * Ambil info owner (nama & username kalau ada) langsung dari Telegram lewat getChat,
 * berdasarkan env.OWNER_USER_ID (angka ID, BUKAN username yang diketik manual).
 * - Kalau owner PUNYA username publik -> ditampilkan sebagai "@username" biasa
 *   (Telegram otomatis bikin ini clickable, gak perlu HTML tambahan).
 * - Kalau owner TIDAK PUNYA username publik -> dibungkus sebagai mention HTML pakai
 *   tg://user?id=<ID>, jadi teksnya tetap tampil bisa-diklik & membuka chat owner,
 *   walau dia gak punya username publik.
 * - Kalau OWNER_USER_ID belum di-set, atau fetch gagal (mis. bot belum pernah
 *   "kenal" chat dengan user itu) -> fallback ke teks/link generik "Owner Bot".
 *
 * CATATAN: getChat cuma bisa berhasil kalau bot pernah punya histori chat dengan
 * user itu (biasanya otomatis terpenuhi karena owner sendiri yang menjalankan
 * command-command khusus owner seperti /listgifts).
 */
async function buildOwnerCreditHtml(env) {
  if (!isOwnerConfigured(env)) return "Owner Bot";

  try {
    const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/getChat`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: Number(env.OWNER_USER_ID) }),
    });
    const data = await res.json().catch(() => ({ ok: false }));

    if (data.ok && data.result) {
      const u = data.result;
      if (u.username) {
        return `@${escapeHtml(u.username)}`;
      }
      const displayName = escapeHtml(u.first_name || "Owner Bot");
      return `<a href="tg://user?id=${env.OWNER_USER_ID}">${displayName}</a>`;
    }
  } catch (e) {
    // diamkan, fallback di bawah
  }

  return `<a href="tg://user?id=${env.OWNER_USER_ID}">Owner Bot</a>`;
}

// ============ STATISTIK BOT (REAL, BUKAN DUMMY) ============

/**
 * /statistik (alias /stats) - Tampilkan statistik penggunaan bot yang REAL,
 * diambil dari counter yang tersimpan di KV (bukan angka dummy/hardcode).
 *
 * Sumber tiap angka:
 *   - stats:totalUses     -> di-increment tiap kali handleMessage() ATAU
 *                             handleCallback() diproses (pesan apa pun yang
 *                             dikirim ke bot, DAN tiap klik tombol inline).
 *   - stats:totalMessages -> di-increment CUMA saat pesan anonim (jenis apa pun)
 *                             berhasil masuk ke antrean inbox seseorang.
 *   - stats:totalUsers    -> di-increment CUMA sekali per user, saat profil
 *                             barunya pertama kali dibuat (getOrCreateProfile).
 *   - stats:launchDate    -> tanggal ISO pertama kali fitur statistik ini aktif
 *                             (di-set otomatis sekali lewat ensureLaunchDate,
 *                             gak perlu diisi manual). UpTime dihitung dari sini.
 */
async function handleStatistikCommand(chatId, env) {
  const [usesRaw, messagesRaw, usersRaw, launchRaw] = await Promise.all([
    env.ANONIM_KV.get(`stats:totalUses`),
    env.ANONIM_KV.get(`stats:totalMessages`),
    env.ANONIM_KV.get(`stats:totalUsers`),
    ensureLaunchDate(env),
  ]);

  const uses = usesRaw ? Number(usesRaw) : 0;
  const messagesCount = messagesRaw ? Number(messagesRaw) : 0;
  const usersCount = usersRaw ? Number(usersRaw) : 0;

  const launchDate = new Date(launchRaw);
  const daysSince = Math.max(0, Math.floor((Date.now() - launchDate.getTime()) / (1000 * 60 * 60 * 24)));

  const text =
    `📊 <b>Bots Statistik</b>\n\n` +
    `📥 Number of uses: ${formatNumber(uses)}\n` +
    `💌 Number of messages: ${formatNumber(messagesCount)}\n\n` +
    `👤 Number of users: ${formatNumber(usersCount)}\n\n` +
    `💬 These data are from ${formatDateID(launchDate)} until now.\n(UpTime : ${daysSince} Days)`;

  await sendMessage(chatId, text, env, { parse_mode: "HTML" });
}

/** Nambahin 1 (atau `amount`) ke counter angka di KV, dipakai buat berbagai statistik. */
async function incrementCounter(key, env, amount = 1) {
  const raw = await env.ANONIM_KV.get(key);
  const current = raw ? Number(raw) : 0;
  await env.ANONIM_KV.put(key, String(current + amount));
}

/**
 * Pastikan `stats:launchDate` sudah tercatat di KV. Kalau belum pernah di-set
 * (mis. baru pertama kali fitur statistik ini aktif), catat waktu SEKARANG
 * sebagai titik mulai penghitungan UpTime, lalu return nilai itu.
 * Kalau sudah pernah di-set sebelumnya, cukup return nilai yang sudah ada
 * (idempotent - gak akan ke-reset ulang tiap request).
 */
async function ensureLaunchDate(env) {
  const existing = await env.ANONIM_KV.get(`stats:launchDate`);
  if (existing) return existing;
  const now = new Date().toISOString();
  await env.ANONIM_KV.put(`stats:launchDate`, now);
  return now;
}

/** Format angka pakai pemisah ribuan koma, mis. 2868943 -> "2,868,943". */
function formatNumber(n) {
  return n.toLocaleString("en-US");
}

/** Format tanggal ke gaya "22 Januari 2023". */
function formatDateID(date) {
  const bulan = [
    "Januari", "Februari", "Maret", "April", "Mei", "Juni",
    "Juli", "Agustus", "September", "Oktober", "November", "Desember",
  ];
  return `${date.getDate()} ${bulan[date.getMonth()]} ${date.getFullYear()}`;
}

// ============ CALLBACK (TOMBOL INLINE) HANDLER ============

async function handleCallback(cq, env) {
  const chatId = cq.message.chat.id;
  const messageId = cq.message.message_id;
  const userId = cq.from.id;
  const data = cq.data;

  // klik tombol inline juga dihitung sebagai "penggunaan" bot
  await incrementCounter(`stats:totalUses`, env);

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
  } else if (data.startsWith("toggle:")) {
    // generik: berlaku buat semua jenis media di MEDIA_TYPES (mis. "toggle:video", "toggle:sticker")
    const key = data.slice("toggle:".length);
    if (MEDIA_TYPES.some((m) => m.key === key)) {
      await toggleMediaSetting(userId, key, env);
      await editMediaMenu(chatId, messageId, userId, env);
    }
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
    await sendMessage(chatId, "✍️ Ketik balasan anonim kamu sekarang (boleh teks atau media apa pun).", env);
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

/** Bangun tombol menu Media secara otomatis dari MEDIA_TYPES, plus baris Teks (selalu aktif). */
function mediaKeyboard(settings) {
  const rows = [[{ text: "📝 Teks: ✅ (selalu aktif)", callback_data: "noop" }]];
  for (const m of MEDIA_TYPES) {
    rows.push([{ text: `${m.label}: ${settings[m.key] ? "✅" : "❌"}`, callback_data: `toggle:${m.key}` }]);
  }
  rows.push([{ text: "⬅️ Kembali", callback_data: "menu:back" }]);
  return { inline_keyboard: rows };
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
  const settings = resolveMediaSettings(profile);
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
 *
 * CATATAN (RESOLVED): sebelumnya ada 2 gift dengan emoji hint 🎂 sama-sama 50 Stars
 * (ID 6046178578163303744 dan ID 5170144170496491616), dan salah satunya ternyata
 * bukan kue melainkan "Boneka Beruang Tentara" (field sticker.emoji-nya kebetulan
 * sama). Sudah diverifikasi manual lewat preview sticker asli di /listgifts, dan
 * ID-nya SUDAH DITUKAR ke pasangan yang benar di bawah ini:
 *   - cake -> 5170144170496491616
 *   - bear -> 6046178578163303744
 */
const GIFT_CATALOG = [
  // telegramGiftId & realPrice diisi dari hasil /listgifts (dicocokkan lewat sticker
  // asli, bukan cuma emoji hint). price = harga jual ke pembeli (sesuai daftar harga
  // terbaru).
  { id: "heart", emoji: "💝", label: "Hati & Pita", price: 45, telegramGiftId: "5170145012310081615", realPrice: 15 },
  { id: "box", emoji: "🎁", label: "Kado", price: 75, telegramGiftId: "5170250947678437525", realPrice: 25 },
  { id: "rose", emoji: "🌹", label: "Mawar", price: 75, telegramGiftId: "5168103777563050263", realPrice: 25 },
  { id: "cake", emoji: "🎂", label: "Kue Ulang Tahun", price: 150, telegramGiftId: "5170144170496491616", realPrice: 50 },
  { id: "bear", emoji: "🧸", label: "Boneka Beruang Tentara", price: 200, telegramGiftId: "6046178578163303744", realPrice: 50 },
  { id: "bouquet", emoji: "💐", label: "Buket Bunga", price: 150, telegramGiftId: "5170314324215857265", realPrice: 50 },
  { id: "rocket", emoji: "🚀", label: "Roket", price: 150, telegramGiftId: "5170564780938756245", realPrice: 50 },
  { id: "champagne", emoji: "🍾", label: "Sampanye", price: 150, telegramGiftId: "6028601630662853006", realPrice: 50 },
  { id: "trophy", emoji: "🏆", label: "Piala", price: 350, telegramGiftId: "5168043875654172773", realPrice: 100 },
  { id: "ring", emoji: "💍", label: "Cincin", price: 350, telegramGiftId: "5170690322832818290", realPrice: 100 },
  { id: "diamond", emoji: "💎", label: "Berlian", price: 350, telegramGiftId: "5170521118301225164", realPrice: 100 },
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
 * Kirim tiap gift sebagai STIKER dulu (pakai file_id dari field `sticker` di
 * response getAvailableGifts) SEBELUM caption teks ID/harga nyusul. Ini penting
 * terutama buat gift-gift yang emoji hint-nya sama/duplikat (misal ada 2 gift
 * sama-sama muncul sebagai 🎂 padahal beda wujud) — dengan liat stiker aslinya,
 * owner bisa mastiin ID mana yang cocok buat item apa di GIFT_CATALOG.
 */
async function handleListGifts(chatId, env) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/getAvailableGifts`;
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const data = await res.json().catch(() => ({ ok: false }));

  if (!data.ok || !data.result?.gifts?.length) {
    await sendMessage(chatId, "Gagal ambil daftar gift dari Telegram, atau memang lagi kosong.", env);
    return;
  }

  await sendMessage(chatId, `🎁 Ditemukan ${data.result.gifts.length} gift:`, env);

  for (const g of data.result.gifts) {
    const limited = g.total_count ? ` (limited: ${g.remaining_count ?? "?"}/${g.total_count})` : "";
    const emojiHint = g.sticker?.emoji || "🎁";

    // Kirim stiker dulu (kalau file_id ada) biar owner LIHAT WUJUD ASLI gift-nya,
    // karena emoji hint di atas kadang sama walau gift-nya beda (lihat catatan
    // di GIFT_CATALOG soal pasangan 🎂 yang sempat tertukar).
    if (g.sticker?.file_id) {
      await sendSticker(chatId, g.sticker.file_id, env);
    }

    const caption = `${emojiHint} ID: ${g.id} — ${g.star_count} Stars${limited}`;
    await sendMessage(chatId, caption, env);
  }

  await sendMessage(
    chatId,
    "Salin ID & harga Stars yang kamu mau ke GIFT_CATALOG (field telegramGiftId & realPrice), cocokkan sama STIKER yang muncul di atas (bukan cuma emoji hint di captionnya, karena bisa duplikat/gak akurat) ya.",
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
    settings: defaultMediaSettings(),
  };
  await env.ANONIM_KV.put(`user:${userId}`, JSON.stringify(profile));
  await env.ANONIM_KV.put(`code:${code}`, String(userId));

  // catat "jumlah pengguna" global (dipakai buat /statistik) - cuma dihitung SEKALI
  // per user, karena blok ini cuma dieksekusi saat profil BARU dibuat.
  await incrementCounter(`stats:totalUsers`, env);

  return profile;
}

async function toggleMediaSetting(userId, key, env) {
  const profile = await getProfile(userId, env);
  if (!profile) return;
  const settings = resolveMediaSettings(profile);
  settings[key] = !settings[key];
  profile.settings = settings;
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

/** GIF & "foto bergerak" - keduanya dikirim balik lewat sendAnimation (lihat catatan MEDIA_TYPES). */
async function sendAnimation(chatId, fileId, caption, env, extra = {}) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendAnimation`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, animation: fileId, caption, ...extra }),
  });
  return res.json().catch(() => null);
}

async function sendVideo(chatId, fileId, caption, env, extra = {}) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendVideo`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, video: fileId, caption, ...extra }),
  });
  return res.json().catch(() => null);
}

/** Pesan video bulat (video note) - Bot API tidak mendukung caption untuk tipe ini. */
async function sendVideoNote(chatId, fileId, env, extra = {}) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendVideoNote`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, video_note: fileId, ...extra }),
  });
  return res.json().catch(() => null);
}

async function sendAudio(chatId, fileId, caption, env, extra = {}) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendAudio`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, audio: fileId, caption, ...extra }),
  });
  return res.json().catch(() => null);
}

async function sendVoice(chatId, fileId, caption, env, extra = {}) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendVoice`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, voice: fileId, caption, ...extra }),
  });
  return res.json().catch(() => null);
}

async function sendDocument(chatId, fileId, caption, env, extra = {}) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, document: fileId, caption, ...extra }),
  });
  return res.json().catch(() => null);
}

/** contact = { phone_number, first_name, last_name }. Bot API tidak mendukung caption untuk kontak. */
async function sendContact(chatId, contact, env, extra = {}) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendContact`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      phone_number: contact.phone_number,
      first_name: contact.first_name,
      last_name: contact.last_name || "",
      ...extra,
    }),
  });
  return res.json().catch(() => null);
}

/** location = { latitude, longitude }. Bot API tidak mendukung caption untuk lokasi. */
async function sendLocation(chatId, location, env, extra = {}) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendLocation`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, latitude: location.latitude, longitude: location.longitude, ...extra }),
  });
  return res.json().catch(() => null);
}

/**
 * Kirim stiker (dipakai buat preview visual gift asli Telegram di /listgifts,
 * dan buat teruskan stiker yang dikirim user lewat link anonim).
 * Bot API tidak mendukung caption untuk stiker.
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
