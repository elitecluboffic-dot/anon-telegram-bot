/**
 * Anonymous Message Telegram Bot v3 - Cloudflare Workers
 * -------------------------------------------------------
 * Tambahan dari v3:
 * - Premium sekarang LANGGANAN BULANAN 50 Stars/bulan (bukan sekali bayar selamanya)
 * - Pakai fitur subscription bawaan Telegram Stars (subscription_period),
 *   jadi Telegram yang otomatis re-charge user tiap bulan, bot tinggal terima event-nya
 * - /cancelpremium -> batalkan auto-renew (tetap aktif sampai periode berjalan habis)
 * - Status premium dicek berdasarkan tanggal expiry (premiumUntil), bukan flag boolean statis
 *
 * Struktur data di KV (tambahan field):
 *   user:<userId> -> {
 *     code, name, createdAt, receivedCount,
 *     premium, premiumUntil, premiumChargeId,
 *     settings: { photo: true }
 *   }
 *   awaiting_code:<userId> -> "1"  (state sedang nunggu input kode custom, TTL 5 menit)
 *
 * CATATAN PENTING SOAL TELEGRAM STARS SUBSCRIPTION:
 * - Currency HARUS "XTR" dan provider_token dikosongkan ("").
 * - subscription_period WAJIB diisi 2592000 (= 30 hari dalam detik) -- itu satu-satunya
 *   nilai yang didukung Telegram saat ini untuk subscription Stars.
 * - Wajib handle update "pre_checkout_query" -> jawab ok:true.
 * - Pembayaran (termasuk re-charge otomatis tiap bulan) masuk sebagai message.successful_payment,
 *   dengan field subscription_expiration_date (unix timestamp) yang bot pakai buat set premiumUntil.
 * - User bisa cancel langganan lewat Telegram Settings > My Subscriptions, ATAU
 *   bot bisa cancel via API editUserStarSubscription (dipakai di /cancelpremium).
 * - Kalau user cancel, mereka TETAP premium sampai periode yang sudah dibayar habis,
 *   baru setelah itu tidak di-charge lagi otomatis.
 */

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Anonymous bot v3 is running.", { status: 200 });
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

  // ---- Pembayaran Stars sukses (langganan baru ATAU re-charge bulanan otomatis) ----
  if (message.successful_payment) {
    const sp = message.successful_payment;
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

    const targetUserId = await env.ANONIM_KV.get(`code:${param}`);
    if (!targetUserId) {
      await sendMessage(chatId, "Link tidak valid atau sudah dicabut oleh pemiliknya.", env);
      return;
    }
    if (Number(targetUserId) === userId) {
      await sendMessage(chatId, "Ini link kamu sendiri, gak bisa kirim pesan ke diri sendiri ya.", env);
      return;
    }

    await env.ANONIM_KV.put(`state:${userId}`, targetUserId, { expirationTtl: 3600 });
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

  // ---- Sedang menunggu input kode custom (dari tombol menu) ----
  const awaitingCode = await env.ANONIM_KV.get(`awaiting_code:${userId}`);
  if (awaitingCode) {
    await env.ANONIM_KV.delete(`awaiting_code:${userId}`);
    await trySetCustomCode(chatId, userId, text, env);
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

    if (message.photo && message.photo.length > 0) {
      if (!settings.photo) {
        await sendMessage(chatId, "Maaf, penerima menonaktifkan pengiriman gambar lewat link ini.", env);
        return;
      }
      const fileId = message.photo[message.photo.length - 1].file_id;
      const caption = message.caption ? `\n\n"${message.caption}"` : "";
      await sendPhoto(Number(targetUserId), fileId, `📩 Kamu dapat gambar anonim baru!${caption}`, env, replyButton(userId));
    } else if (text) {
      await sendMessage(Number(targetUserId), `📩 Kamu dapat pesan anonim baru:\n\n"${text}"`, env, replyButton(userId));
    } else {
      await sendMessage(chatId, "Jenis pesan ini belum didukung. Kirim teks atau gambar ya.", env);
      return;
    }

    await incrementReceivedCount(targetUserId, env);
    await sendMessage(chatId, "Pesan berhasil dikirim secara anonim ✅", env);
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
  } else if (data === "menu:share") {
    const profile = await getProfile(userId, env);
    const link = buildLink(profile.code, env);
    await sendMessage(chatId, `Bagikan tautan ini ke teman-temanmu:\n${link}`, env);
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
  } else if (data.startsWith("reply:")) {
    const senderUserId = data.split(":")[1];
    // userId yang klik tombol ini (cq.from.id) mau balas ke senderUserId
    await env.ANONIM_KV.put(`reply_state:${cq.from.id}`, senderUserId, { expirationTtl: 3600 });
    await sendMessage(chatId, "✍️ Ketik balasan anonim kamu sekarang (boleh teks atau gambar).", env);
  }
}

// ============ MENU BUILDERS ============

function mainMenuKeyboard() {
  return { keyboard: [[{ text: "Tautan pribadi saya" }]], resize_keyboard: true };
}

function settingsInlineKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "⚙️ Umum", callback_data: "menu:umum" }, { text: "📎 Media", callback_data: "menu:media" }],
      [{ text: "🧪 Fitur", callback_data: "menu:fitur" }, { text: "🔗 Custom Link", callback_data: "menu:customlink" }],
      [{ text: "🔄 Cabut Tautan", callback_data: "menu:revoke" }],
      [{ text: "📤 Bagikan", callback_data: "menu:share" }, { text: "📋 Salin Tautan", callback_data: "menu:copy" }],
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
 * Tombol "Balas" yang disisipkan di bawah pesan anonim yang diteruskan.
 * originalSenderUserId = user yang TADI mengirim pesan ini (disembunyikan di callback_data,
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
  await sendMessage(chatId, text, env, { reply_markup: settingsInlineKeyboard() });
}

async function editSettingsMenu(chatId, messageId, userId, env, prefix = "") {
  const profile = await getProfile(userId, env);
  const link = buildLink(profile.code, env);
  const text = (prefix ? prefix + "\n\n" : "") + formatStatsText(profile, link);
  await editMessageText(chatId, messageId, text, env, { reply_markup: settingsInlineKeyboard() });
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
    `📅 Tanggal pembuatan tautan: ${profile.createdAt}\n` +
    `🔗 Tautan: ${link}`
  );
}

/** Premium dianggap aktif kalau ada tanggal expiry dan belum lewat. */
function isPremiumActive(profile) {
  if (!profile?.premiumUntil) return false;
  return new Date(profile.premiumUntil.replace(" UTC", "Z").replace(" ", "T")) > new Date();
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
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, ...extra }),
  });
}

async function sendPhoto(chatId, fileId, caption, env, extra = {}) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendPhoto`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, photo: fileId, caption, ...extra }),
  });
}

async function editMessageText(chatId, messageId, text, env, extra = {}) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/editMessageText`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, ...extra }),
  });
}

async function answerCallbackQuery(callbackQueryId, env, text, showAlert = false) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: showAlert }),
  });
}
