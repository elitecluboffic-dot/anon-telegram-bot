/**
 * Anonymous Message Telegram Bot v5 - Cloudflare Workers
 * -------------------------------------------------------
 * Tambahan dari v4:
 * - BARU: tombol "📤 Bagikan" di menu sekarang pakai INLINE MODE Telegram
 *   (switch_inline_query), bukan share-url biasa. Tap tombol -> muncul "Pilih Obrolan"
 *   (chat picker bawaan Telegram) -> pilih chat -> bot ngirim pesan otomatis ke chat
 *   itu (nampil "via @NamaBot") lengkap dengan tombol "Kirim pesan anonim" &
 *   "Kirim hadiah anonim".
 * - BARU: deep link "?start=gift_<code>" -> langsung masuk ke alur pilih hadiah
 *   ke pemilik kode itu, TANPA perlu kirim pesan teks dulu.
 * - PENTING: supaya update inline_query masuk ke webhook, inline mode bot HARUS
 *   diaktifkan dulu lewat @BotFather -> /setinline (isi placeholder bebas, mis.
 *   "Kirim pesan/hadiah anonim..."). Kalau belum diaktifkan, tombol Bagikan tetap
 *   muncul tapi Telegram gak akan minta update ke bot kamu.
 *
 * Tambahan dari v3 (tetap berlaku):
 * - Premium tetap LANGGANAN BULANAN 50 Stars/bulan (subscription_period, tidak berubah)
 * - Fitur "Kirim hadiah anonim" -> user bisa beli hadiah (emoji + harga Stars)
 *   dan kirim ke orang TERAKHIR yang mereka kirimi pesan/hadiah, lengkap dengan pesan
 *   opsional (maks 128 karakter), dibayar pakai Telegram Stars SEKALI BAYAR (bukan subscription).
 * - Menu setelah pesan terkirim -> "Kirim pesan lainnya", "Hapus pesan",
 *   "Kirim hadiah anonim" (reply keyboard, sesuai referensi screenshot).
 * - /cancelpremium tetap ada, tidak berubah dari v3.
 *
 * Struktur data di KV (tambahan field dari v3):
 *   user:<userId> -> {
 *     code, name, createdAt, receivedCount, receivedGifts,
 *     premium, premiumUntil, premiumChargeId,
 *     settings: { photo: true }
 *   }
 *   awaiting_code:<userId>          -> "1"  (nunggu input kode custom, TTL 5 menit)
 *   last_recipient:<userId>        -> targetUserId (orang TERAKHIR yang dikirimi pesan/hadiah)
 *   last_sent:<userId>             -> JSON { targetUserId, messageId } (buat fitur "Hapus pesan")
 *   awaiting_gift_pick:<userId>    -> "1"  (lagi milih hadiah dari katalog, TTL 5 menit)
 *   awaiting_gift_message:<userId> -> "1"  (lagi isi pesan opsional buat hadiah, TTL 15 menit)
 *   pending_gift:<userId>          -> JSON { giftId, targetUserId, message } (TTL 15 menit,
 *                                      dibaca lagi pas successful_payment masuk)
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

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Anonymous bot v4 is running.", { status: 200 });
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
    let sendResult = null;

    if (message.photo && message.photo.length > 0) {
      if (!settings.photo) {
        await sendMessage(chatId, "Maaf, penerima menonaktifkan pengiriman gambar lewat link ini.", env);
        return;
      }
      const fileId = message.photo[message.photo.length - 1].file_id;
      const caption = message.caption ? `\n\n"${message.caption}"` : "";
      sendResult = await sendPhoto(
        Number(targetUserId),
        fileId,
        `📩 Kamu dapat gambar anonim baru!${caption}`,
        env,
        replyButton(userId)
      );
    } else if (text) {
      sendResult = await sendMessage(
        Number(targetUserId),
        `📩 Kamu dapat pesan anonim baru:\n\n"${text}"`,
        env,
        replyButton(userId)
      );
    } else {
      await sendMessage(chatId, "Jenis pesan ini belum didukung. Kirim teks atau gambar ya.", env);
      return;
    }

    await incrementReceivedCount(targetUserId, env);

    // simpan riwayat penerima terakhir (dipakai buat "Kirim pesan lainnya" & "Kirim hadiah anonim")
    await env.ANONIM_KV.put(`last_recipient:${userId}`, String(targetUserId));

    // simpan message_id yang baru dikirim (dipakai buat "Hapus pesan")
    if (sendResult?.result?.message_id) {
      await env.ANONIM_KV.put(
        `last_sent:${userId}`,
        JSON.stringify({ targetUserId: String(targetUserId), messageId: sendResult.result.message_id })
      );
    }

    await sendMessage(chatId, "Pesan berhasil dikirim secara anonim ✅\n\nMau ngapain lagi?", env, {
      reply_markup: postSendKeyboard(),
    });
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
        message_text: `Kirimkan saya pesan anonim atau hadiah:\n${link}`,
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
  { id: "heart", emoji: "💝", label: "Hati & Pita", price: 45 },
  { id: "box", emoji: "🎁", label: "Kado", price: 75 },
  { id: "rose", emoji: "🌹", label: "Mawar", price: 75 },
  { id: "cake", emoji: "🎂", label: "Kue Ulang Tahun", price: 150 },
  { id: "bouquet", emoji: "💐", label: "Buket Bunga", price: 150 },
  { id: "rocket", emoji: "🚀", label: "Roket", price: 150 },
  { id: "champagne", emoji: "🍾", label: "Sampanye", price: 150 },
  { id: "trophy", emoji: "🏆", label: "Piala", price: 300 },
  { id: "ring", emoji: "💍", label: "Cincin", price: 300 },
  { id: "diamond", emoji: "💎", label: "Berlian", price: 300 },
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

  const caption =
    `🎁 Kamu dapat hadiah anonim: ${gift.emoji} ${gift.label}!` +
    (pending.message ? `\n\nPesan: "${escapeHtml(pending.message)}"` : "");

  await sendMessage(targetUserId, caption, env, replyButton(userId));
  await incrementGiftCount(targetUserId, env);

  await env.ANONIM_KV.delete(`pending_gift:${userId}`);
  await sendMessage(chatId, "🎉 Hadiah berhasil dikirim secara anonim!", env, { reply_markup: postSendKeyboard() });
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
