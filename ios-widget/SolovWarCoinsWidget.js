// SolovWar C 幣 Scriptable Widget
// 使用方式：將本檔貼到 iPhone 的 Scriptable App 後執行。
// 需要先在 Cloudflare Worker 設定同一組 WIDGET_COINS_API_SECRET。

const CONFIG = {
  // 改成目標 Discord 使用者 ID；必須與 Worker 的 WIDGET_DISCORD_ID 相同。
  discordId: "1234567890",
  endpoint: "https://solovwar-discord-auth.solovwar-auth.workers.dev/api/widget/coins",

  // 請勿提交到 GitHub 或公開分享。這是唯讀 Widget Token，不是 Discord Bot Token。
  widgetToken: "請在這裡貼上 Cloudflare WIDGET_COINS_API_SECRET",

  refreshMinutes: 30,
  cacheKey: "solovwar-widget-coin-cache"
};

function fail(message) {
  throw new Error(message);
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-TW").format(value);
}

async function fetchBalance() {
  if (!/^\d{17,20}$/.test(CONFIG.discordId)) {
    fail("Discord ID 必須是 17–20 位數字");
  }
  if (!CONFIG.widgetToken || CONFIG.widgetToken.length < 32 || CONFIG.widgetToken.includes("請在這裡")) {
    fail("尚未設定 Widget Token");
  }

  const request = new Request(`${CONFIG.endpoint}?discordId=${encodeURIComponent(CONFIG.discordId)}`);
  request.method = "GET";
  request.headers = {
    "Accept": "application/json",
    "Authorization": `Bearer ${CONFIG.widgetToken}`
  };
  request.timeoutInterval = 15;

  const response = await request.loadJSON();
  if (!response || !Number.isSafeInteger(response.balance) || response.balance < 0) {
    fail("API 回應格式錯誤");
  }
  if (response.discordId && response.discordId !== CONFIG.discordId) {
    fail("API 回傳了錯誤的 Discord ID");
  }

  Keychain.set(CONFIG.cacheKey, JSON.stringify({
    balance: response.balance,
    savedAt: new Date().toISOString()
  }));
  return { balance: response.balance, cached: false, savedAt: new Date() };
}

function loadCache() {
  if (!Keychain.contains(CONFIG.cacheKey)) return null;
  try {
    const value = JSON.parse(Keychain.get(CONFIG.cacheKey));
    const savedAt = new Date(value.savedAt);
    if (!Number.isSafeInteger(value.balance) || value.balance < 0 || Number.isNaN(savedAt.getTime())) return null;
    if (Date.now() - savedAt.getTime() > 24 * 60 * 60 * 1000) return null;
    return { balance: value.balance, cached: true, savedAt };
  } catch (_) {
    return null;
  }
}

function applyWidgetStyle(widget, data) {
  const background = new LinearGradient();
  background.colors = [new Color("0D1A29"), new Color("1A344A")];
  background.locations = [0, 1];
  widget.backgroundGradient = background;

  const title = widget.addText("SolovWar");
  title.textColor = Color.white();
  title.font = Font.boldSystemFont(15);

  widget.addSpacer(8);

  const coin = widget.addText(`C  ${formatNumber(data.balance)}`);
  coin.textColor = new Color("FFD54A");
  coin.font = Font.boldSystemFont(24);
  coin.minimumScaleFactor = 0.6;

  widget.addSpacer(4);

  const status = widget.addText(data.cached ? "離線快取" : "C 幣餘額");
  status.textColor = data.cached ? new Color("FFB15C") : new Color("B6C7D6");
  status.font = Font.systemFont(11);
}

function errorWidget(message, cached) {
  const widget = new ListWidget();
  widget.backgroundColor = new Color("18222D");
  const title = widget.addText("SolovWar");
  title.textColor = Color.white();
  title.font = Font.boldSystemFont(15);
  widget.addSpacer(8);
  const text = widget.addText(cached ? "無法更新，顯示快取" : "暫時無法取得 C 幣");
  text.textColor = new Color("FFB15C");
  text.font = Font.systemFont(13);
  widget.addSpacer(4);
  const detail = widget.addText(message);
  detail.textColor = new Color("B6C7D6");
  detail.font = Font.systemFont(10);
  return widget;
}

async function main() {
  let data;
  try {
    data = await fetchBalance();
  } catch (error) {
    const cached = loadCache();
    if (cached) {
      data = cached;
    } else {
      const widget = errorWidget(error.message || "請稍後再試", false);
      widget.refreshAfterDate = new Date(Date.now() + CONFIG.refreshMinutes * 60 * 1000);
      Script.setWidget(widget);
      if (!config.runsInWidget) await widget.presentSmall();
      Script.complete();
      return;
    }
  }

  const widget = new ListWidget();
  applyWidgetStyle(widget, data);
  widget.refreshAfterDate = new Date(Date.now() + CONFIG.refreshMinutes * 60 * 1000);
  Script.setWidget(widget);
  if (!config.runsInWidget) await widget.presentSmall();
  Script.complete();
}

await main();
