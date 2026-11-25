"""
C幣交易系統（由 bot.py 自動載入）

  /coin —— 開啟 C幣面板（只有你自己看得到）：
           📅 每日簽到　　　每天可領一次 DAILY_REWARD 枚
           <:CCOIN:1567144433982513192> 查看餘額　重新整理並顯示目前有多少 C幣
           💸 轉帳　　　　　選擇對象 → 輸入金額 → 轉 C幣給對方
           🎲 賭C幣　　　　 （第二排）選倍率 → 輸入投注金額 → 賭一把：中獎得「投注 × 倍率」，倍率越高越難中
           ⛏️ 挖礦　　　　　（第二排）每 6 小時可挖一次：隨機挖到多種加密貨幣（含川普幣），依當下行情自動換成 C幣 存進帳戶

  管理員發放 —— 在 /backend 後台面板按「發放 C幣」，可直接給自己或指定使用者 C幣（按鈕在 admin.py）。

說明：
  · C幣是「全域」的：同一個人在所有伺服器與 SolovWar 遊戲共用 Worker D1 的同一份餘額；bot.db 的 coins 表只供首次匯入舊資料。
  · 簽到的「一天」以台灣時間（UTC+8）午夜 00:00 為界，到了 00:00 就能再簽一次。
  · 賭C幣：中獎機率 = GAMBLE_RTP ÷ 倍率（預設 95%，即 2 倍 47.5%、10 倍 9.5%、100 倍 0.95%）。
    中獎得到「投注金額 × 倍率」（已含本金）；沒中就失去投注金額。扣款與派獎在同一個交易內完成。
  · 挖礦：冷卻 MINE_COOLDOWN 秒（預設 6 小時），時間記在 coins 表的 last_mine 欄位（重開機也不會重置）。
    每次隨機挖到 2～4 種幣（見 MINE_COINS，可自行增減幣種、機率與數量），每種幣有隨機的當下行情（單價上下浮動），
    數量 × 單價 = 換成的 C幣；川普幣（TRUMP）行情波動特別大，可能暴漲也可能暴跌。這是純模擬，不是真實行情。
  · 想調整簽到金額、時區、賭局倍率範圍、挖礦冷卻與幣種等，改下面的「設定」區就好。
"""

import asyncio
import datetime
import math
import secrets
import time
import traceback
from decimal import ROUND_FLOOR, ROUND_HALF_UP, Decimal, InvalidOperation

import discord
from discord import app_commands
from discord.ext import commands

from coin_api import CoinAPI, CoinAPIError

# ═══════════════ 設定（可自行調整） ═══════════════
COIN_EMOJI = "<:CCOIN:1567144433982513192>"     # C幣表情符號
COIN_NAME = "C幣"
DAILY_REWARD = 100                              # 每日簽到可領幾枚
MAX_GRANT = 1_000_000_000                       # 管理員單次最多可發放幾枚
VIEW_TIMEOUT = 300                              # 面板閒置幾秒後自動停用按鈕
RESET_TZ = datetime.timezone(datetime.timedelta(hours=8))   # 簽到重置時區：UTC+8（台灣）

# ── 賭C幣設定 ──
GAMBLE_RTP = 0.95                    # 期望回報率：中獎機率 = RTP ÷ 倍率。0.95 = 抽水 5%，長期玩會小虧，C幣才不會無限膨脹（1.0 = 完全公平）
GAMBLE_MIN_MULT = Decimal("1.1")     # 最低倍率
GAMBLE_MAX_MULT = Decimal("100")     # 最高倍率
GAMBLE_MAX_BET = 1_000_000           # 單次最多可下注幾枚
GAMBLE_PRESETS = ("1.5", "2", "3", "5", "10", "25", "50", "100")   # 倍率下拉選單的選項（也可在輸入視窗自訂）

# ── 挖礦設定 ──
MINE_COOLDOWN = 6 * 60 * 60          # 挖礦冷卻（秒）：6 小時
MINE_DROPS = (2, 4)                  # 每次隨機挖到幾「種」幣（最少, 最多）
# 每個幣種：代號、名稱、圖示、機率權重、單價（1 枚值幾 C幣）、挖到數量範圍、數量小數位數、行情浮動範圍（單價 × (1+浮動)）
#   · 權重越大越容易挖到；單價是模擬用的固定基準價，實際換算時會再乘上這次隨機的行情浮動
#   · 想新增幣種，照樣複製一行加在後面即可
MINE_COINS = (
    #  代號    名稱        圖示    權重  單價       數量範圍                小數  行情浮動
    ("BTC",   "比特幣",    "🟠",  10,  100_000,   (0.00010, 0.00045),   5,   (-0.15, 0.15)),
    ("ETH",   "以太幣",    "🔷",  16,    3_500,   (0.0020, 0.0080),     4,   (-0.15, 0.15)),
    ("BNB",   "幣安幣",    "🟡",  14,      600,   (0.010, 0.040),       3,   (-0.15, 0.15)),
    ("SOL",   "索拉納",    "🟣",  16,      180,   (0.040, 0.160),       3,   (-0.20, 0.20)),
    ("XRP",   "瑞波幣",    "⚪",  18,      2.5,   (2.0, 9.0),           2,   (-0.20, 0.20)),
    ("ADA",   "卡爾達諾",  "🔵",  14,      0.7,   (8.0, 35.0),          2,   (-0.20, 0.20)),
    ("LTC",   "萊特幣",    "⚫",  12,      100,   (0.040, 0.220),       3,   (-0.15, 0.15)),
    ("DOGE",  "狗狗幣",    "🐕",  20,      0.2,   (25.0, 100.0),        2,   (-0.30, 0.30)),
    ("SHIB",  "柴犬幣",    "🐶",  14,  0.00002,   (300_000, 1_100_000), 0,   (-0.30, 0.30)),
    ("TRUMP", "川普幣",    "🇺🇸", 20,       10,   (0.5, 4.0),           2,   (-0.70, 3.00)),   # 迷因幣：行情 -70% ～ +300%
)
# ═══════════════════════════════════════════════════


def fmt(amount: int) -> str:
    """12345 → '12,345 <:CCOIN:...>'"""
    return f"{amount:,} {COIN_EMOJI}"


def today_str() -> str:
    return datetime.datetime.now(RESET_TZ).strftime("%Y-%m-%d")


def parse_amount(text: str) -> int | None:
    """把使用者輸入的數字轉成整數（接受 1,000 這種寫法）；不是數字回傳 None。"""
    try:
        return int(text.replace(",", "").replace("，", "").strip())
    except ValueError:
        return None


def parse_multiplier(text: str) -> Decimal | None:
    """把輸入的倍率轉成 Decimal（接受 2、2.5、5x、10倍）；不是有限數字回傳 None。"""
    text = text.strip().lower().rstrip("x×倍").strip()
    try:
        value = Decimal(text)
    except InvalidOperation:
        return None
    return value if value.is_finite() else None


def fmt_mult(multiplier: Decimal) -> str:
    """Decimal('2.50') → '2.5'；Decimal('100') → '100'"""
    return format(multiplier.normalize(), "f")


def win_chance(multiplier: Decimal) -> float:
    """倍率越高，中獎機率越低。"""
    return GAMBLE_RTP / float(multiplier)


def gamble_payout(bet: int, multiplier: Decimal) -> int:
    """獎金 = 投注金額 × 倍率（無條件捨去成整數；用 Decimal 避免 1.15 × 100 = 114.99… 的誤差）。"""
    return int((Decimal(bet) * multiplier).to_integral_value(rounding=ROUND_FLOOR))


_rng = secrets.SystemRandom()   # 用系統亂數源，結果無法預測


def fmt_duration(seconds: int) -> str:
    """3725 → '1 小時 2 分鐘'；不到一分鐘顯示「不到 1 分鐘」。"""
    minutes = max(0, math.ceil(seconds / 60))
    hours, minutes = divmod(minutes, 60)
    if hours and minutes:
        return f"{hours} 小時 {minutes} 分鐘"
    if hours:
        return f"{hours} 小時"
    return f"{minutes} 分鐘" if minutes else "不到 1 分鐘"


def roll_mining() -> list[dict]:
    """模擬一次挖礦：依權重隨機挑幾種幣（不重複），算出各自的數量、行情與換成的 C幣。"""
    pool = list(MINE_COINS)
    drops = []
    for _ in range(min(_rng.randint(*MINE_DROPS), len(pool))):
        coin = _rng.choices(pool, weights=[c[3] for c in pool])[0]
        pool.remove(coin)
        symbol, name, icon, _w, price, (q_lo, q_hi), decimals, (t_lo, t_hi) = coin
        qty = round(_rng.uniform(q_lo, q_hi), decimals)
        qty = qty or 10 ** -decimals                                  # 避免四捨五入成 0
        trend = _rng.uniform(t_lo, t_hi)                              # 這次的行情浮動（例如 +0.12 = 漲 12%）
        value = max(1, math.floor(qty * price * (1 + trend)))         # 每種幣至少換到 1 C幣
        drops.append({
            "symbol": symbol, "name": name, "icon": icon,
            "qty": qty, "decimals": decimals, "trend": trend, "value": value,
        })
    return drops


def mining_embed(owner: discord.abc.User, drops: list[dict], total: int, balance: int) -> discord.Embed:
    """挖礦成果的訊息。"""
    lines = []
    for d in drops:
        if d["trend"] >= 0.5:
            arrow = "🚀"
        elif d["trend"] <= -0.5:
            arrow = "💥"
        else:
            arrow = "📈" if d["trend"] >= 0 else "📉"
        qty = f"{d['qty']:,.{d['decimals']}f}"
        lines.append(
            f"{d['icon']} **{d['name']}**　{qty} {d['symbol']}\n"
            f"　└ 行情 {arrow} {d['trend'] * 100:+.0f}% → **+{d['value']:,}** {COIN_EMOJI}"
        )
    embed = discord.Embed(
        title="⛏️ 挖礦完成！",
        description="\n".join(lines) + f"\n\n**本次共換得 {fmt(total)}**\n目前餘額：{fmt(balance)}",
        color=discord.Color.orange(),
    )
    embed.set_author(name=owner.display_name, icon_url=owner.display_avatar.url)
    embed.set_footer(text=f"模擬挖礦，行情為隨機產生 · 每 {MINE_COOLDOWN // 3600} 小時可挖一次")
    return embed


# ───────────────────────── 共用基底 ─────────────────────────
async def safe_reply(interaction: discord.Interaction, content: str) -> None:
    """錯誤處理裡用的回覆：就算回覆失敗（被限速、互動已過期）也只記一行，不會在錯誤處理裡再丟出新的例外。"""
    try:
        if interaction.response.is_done():
            await interaction.followup.send(content, ephemeral=True)
        else:
            await interaction.response.send_message(content, ephemeral=True)
    except (discord.HTTPException, discord.RateLimited, discord.InteractionResponded) as error:
        print(f"[回覆失敗] {type(error).__name__}: {str(error)[:120]}")


class OwnerView(discord.ui.View):
    """只有開啟面板的人能操作；閒置逾時後停用按鈕。"""

    def __init__(self, cog: "Coins", owner: discord.abc.User):
        super().__init__(timeout=VIEW_TIMEOUT)
        self.cog = cog
        self.owner = owner
        self.source: discord.Interaction | None = None  # 逾時時用來停用按鈕

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        if interaction.user.id != self.owner.id:
            await interaction.response.send_message("這是別人的面板，用 `/coin` 開自己的吧！", ephemeral=True)
            return False
        return True

    async def on_timeout(self):
        for item in self.children:
            item.disabled = True
        if self.source:
            try:
                await self.source.edit_original_response(view=self)
            except discord.HTTPException:
                pass

    async def on_error(self, interaction: discord.Interaction, error: Exception, item: discord.ui.Item):
        traceback.print_exception(type(error), error, error.__traceback__)
        message = (
            "❌ 共用 C 幣服務目前無法完成操作。請稍後重新整理餘額；若是轉帳／扣款，先確認交易狀態再重試。"
            if isinstance(error, CoinAPIError)
            else "❌ 操作失敗，請稍後再試。"
        )
        await safe_reply(interaction, message)


# ───────────────────────── 主面板 ─────────────────────────
class CoinPanel(OwnerView):
    async def render(self) -> discord.Embed:
        """依目前資料產生面板內容，並同步簽到按鈕的狀態。"""
        balance, last_daily = await self.cog.get_account(self.owner.id)
        signed = last_daily == today_str()
        mine_ready_at = await self.cog.mine_ready_at(self.owner.id)   # 0 = 現在就能挖
        cooling = mine_ready_at > time.time()

        self.daily.disabled = signed
        self.daily.label = "今日已簽到" if signed else "每日簽到"
        self.daily.style = discord.ButtonStyle.secondary if signed else discord.ButtonStyle.success

        self.mine.disabled = cooling
        self.mine.label = "挖礦冷卻中" if cooling else "挖礦"
        self.mine.style = discord.ButtonStyle.secondary if cooling else discord.ButtonStyle.success

        embed = discord.Embed(
            title=f"{COIN_NAME}錢包",
            description=f"**目前餘額**\n{COIN_EMOJI} **{balance:,}**",
            color=discord.Color.gold(),
        )
        embed.set_author(name=self.owner.display_name, icon_url=self.owner.display_avatar.url)
        embed.add_field(
            name="每日簽到",
            value="✅ 今天已經簽到過了，明天再來吧！" if signed else f"📅 今天還沒簽到，按下「每日簽到」領 {fmt(DAILY_REWARD)}",
            inline=False,
        )
        embed.add_field(
            name="挖礦",
            value=(
                f"⏳ 礦機冷卻中，<t:{int(mine_ready_at)}:R> 可再挖（時間到了按「查看餘額」重新整理）"
                if cooling
                else f"⛏️ 礦機待命中，按下「挖礦」就能開挖！（每 {MINE_COOLDOWN // 3600} 小時一次）"
            ),
            inline=False,
        )
        embed.set_footer(text="簽到每天 00:00（UTC+8）重置 · 閒置 5 分鐘後自動停用")
        return embed

    @discord.ui.button(label="每日簽到", emoji="📅", style=discord.ButtonStyle.success, row=0)
    async def daily(self, interaction: discord.Interaction, button: discord.ui.Button):
        claimed, _ = await self.cog.claim_daily(self.owner.id)
        notice = (
            f"✅ 簽到成功！獲得 {fmt(DAILY_REWARD)}"
            if claimed
            else "⏳ 你今天已經簽到過了，明天 00:00 之後再來吧！"
        )
        await interaction.response.edit_message(content=notice, embed=await self.render(), view=self)

    @discord.ui.button(label="查看餘額", emoji=COIN_EMOJI, style=discord.ButtonStyle.primary, row=0)
    async def balance(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.edit_message(content=None, embed=await self.render(), view=self)

    @discord.ui.button(label="轉帳", emoji="💸", style=discord.ButtonStyle.primary, row=0)
    async def transfer(self, interaction: discord.Interaction, button: discord.ui.Button):
        view = TransferView(self.cog, self.owner)
        view.source = self.source
        self.stop()
        await interaction.response.edit_message(content=None, embed=await view.render(), view=view)

    @discord.ui.button(label="賭C幣", emoji="🎲", style=discord.ButtonStyle.danger, row=1)
    async def gamble(self, interaction: discord.Interaction, button: discord.ui.Button):
        view = GambleView(self.cog, self.owner)
        view.source = self.source
        self.stop()
        await interaction.response.edit_message(content=None, embed=await view.render(), view=view)

    @discord.ui.button(label="挖礦", emoji="⛏️", style=discord.ButtonStyle.success, row=1)
    async def mine(self, interaction: discord.Interaction, button: discord.ui.Button):
        result = await self.cog.mine(self.owner.id)
        if result is None:
            # 還在冷卻（可能是在別的面板挖過，或按鈕是舊的）
            ready_at = await self.cog.mine_ready_at(self.owner.id)
            wait = max(0, int(ready_at - time.time()))
            notice = f"⏳ 礦機還在冷卻，還要 {fmt_duration(wait)} 才能再挖。"
            return await interaction.response.edit_message(content=notice, embed=await self.render(), view=self)

        drops, total, balance = result
        print(
            f"[C幣] {self.owner}（{self.owner.id}）挖礦 "
            + "、".join(f"{d['symbol']}→{d['value']}" for d in drops)
            + f" 共 +{total}，餘額 {balance}"
        )
        # 結果放在最上面，下面接著更新後的面板（下一次按任何按鈕就會回到一般面板）
        await interaction.response.edit_message(
            content=None,
            embeds=[mining_embed(self.owner, drops, total, balance), await self.render()],
            view=self,
        )


# ───────────────────────── 轉帳 ─────────────────────────
class TransferModal(discord.ui.Modal):
    def __init__(self, cog: "Coins", owner: discord.abc.User, target: discord.abc.User, source, balance: int):
        super().__init__(title=f"轉帳給 {target.display_name}"[:45])
        self.cog = cog
        self.owner = owner
        self.target = target
        self.source = source
        # 輸入框在這裡建立（而不是寫成類別屬性），這樣每次開啟都是獨立的一份、提示文字也能放最大可轉金額
        self.amount = discord.ui.TextInput(label="轉帳金額", placeholder=f"最多 {balance:,}", max_length=18)
        self.add_item(self.amount)

    async def on_submit(self, interaction: discord.Interaction):
        amount = parse_amount(self.amount.value)
        if amount is None or amount < 1:
            return await interaction.response.send_message("❌ 金額必須是大於 0 的整數。", ephemeral=True)

        if not await self.cog.transfer(self.owner.id, self.target.id, amount):
            balance = await self.cog.get_balance(self.owner.id)
            return await interaction.response.send_message(
                f"❌ 餘額不足！你目前只有 {fmt(balance)}。", ephemeral=True
            )

        print(f"[C幣] {self.owner}（{self.owner.id}）轉帳 {amount} 給 {self.target}（{self.target.id}）")

        # 回到主面板，並顯示轉帳結果
        panel = CoinPanel(self.cog, self.owner)
        panel.source = self.source
        await interaction.response.edit_message(
            content=f"✅ 已轉帳 {fmt(amount)} 給 {self.target.mention}",
            embed=await panel.render(),
            view=panel,
        )

        # 在頻道公開通知，讓收款人知道（沒有發言權限就略過）
        if interaction.channel is not None:
            try:
                await interaction.channel.send(
                    f"💸 {self.owner.mention} 轉了 {fmt(amount)} 給 {self.target.mention}！",
                    allowed_mentions=discord.AllowedMentions(users=True),
                )
            except (discord.Forbidden, discord.HTTPException):
                pass

    async def on_error(self, interaction: discord.Interaction, error: Exception):
        traceback.print_exception(type(error), error, error.__traceback__)
        message = (
            "❌ 共用 C 幣服務暫時無法確認交易結果，請先重新整理餘額，確認後再重試。"
            if isinstance(error, CoinAPIError)
            else "❌ 轉帳失敗，請稍後再試。"
        )
        await safe_reply(interaction, message)


class TransferView(OwnerView):
    """先選對象，再按「輸入金額」。"""

    def __init__(self, cog: "Coins", owner: discord.abc.User):
        super().__init__(cog, owner)
        self.target: discord.abc.User | None = None

    async def render(self) -> discord.Embed:
        balance = await self.cog.get_balance(self.owner.id)
        if self.target is None:
            step = "請從下方選單選擇要轉帳給誰。"
        else:
            step = f"轉帳對象：{self.target.mention}\n確認沒選錯後，按「輸入金額」。"
        embed = discord.Embed(
            title="轉帳",
            description=f"{step}\n\n你目前有 {fmt(balance)}",
            color=discord.Color.blurple(),
        )
        embed.set_footer(text="轉帳後無法復原，請確認對象正確")
        return embed

    @discord.ui.select(
        cls=discord.ui.UserSelect, placeholder="👤 選擇要轉帳給誰", min_values=1, max_values=1, row=0
    )
    async def pick(self, interaction: discord.Interaction, select: discord.ui.UserSelect):
        user = select.values[0]
        if user.bot:
            return await interaction.response.send_message("❌ 不能轉帳給機器人。", ephemeral=True)
        if user.id == self.owner.id:
            return await interaction.response.send_message("❌ 不能轉帳給自己。", ephemeral=True)
        self.target = user
        self.enter.disabled = False
        await interaction.response.edit_message(embed=await self.render(), view=self)

    @discord.ui.button(label="輸入金額", emoji="💸", style=discord.ButtonStyle.success, disabled=True, row=1)
    async def enter(self, interaction: discord.Interaction, button: discord.ui.Button):
        if self.target is None:  # 理論上按鈕在選人前是停用的，保險起見
            return await interaction.response.send_message("請先選擇轉帳對象。", ephemeral=True)
        balance = await self.cog.get_balance(self.owner.id)
        if balance < 1:
            return await interaction.response.send_message("❌ 你目前沒有 C幣可以轉帳。", ephemeral=True)
        await interaction.response.send_modal(
            TransferModal(self.cog, self.owner, self.target, self.source, balance)
        )

    @discord.ui.button(label="返回", emoji="⬅️", style=discord.ButtonStyle.secondary, row=1)
    async def back(self, interaction: discord.Interaction, button: discord.ui.Button):
        panel = CoinPanel(self.cog, self.owner)
        panel.source = self.source
        self.stop()
        await interaction.response.edit_message(content=None, embed=await panel.render(), view=panel)


# ───────────────────────── 賭C幣 ─────────────────────────
ALL_IN_WORDS = ("all", "全部", "全下", "梭哈")


def mult_options() -> list[discord.SelectOption]:
    """倍率下拉選單的選項（每個面板各自建立一份）。"""
    options = []
    for text in GAMBLE_PRESETS:
        m = Decimal(text)
        options.append(discord.SelectOption(label=f"{fmt_mult(m)} 倍　中獎機率 {win_chance(m) * 100:.2f}%", value=text))
    return options


class GambleModal(discord.ui.Modal):
    """輸入投注金額與倍率（倍率會預先填入面板上選的值，可直接改成自訂的）。"""

    def __init__(self, cog: "Coins", owner: discord.abc.User, parent: "GambleView", balance: int):
        super().__init__(title="🎲 賭C幣")
        self.cog = cog
        self.owner = owner
        self.parent = parent
        cap = min(balance, GAMBLE_MAX_BET)
        self.amount = discord.ui.TextInput(
            label="投注金額", placeholder=f"最多 {cap:,}（輸入 all 全下）", max_length=18
        )
        self.mult = discord.ui.TextInput(
            label=f"獎金倍率（{fmt_mult(GAMBLE_MIN_MULT)}~{fmt_mult(GAMBLE_MAX_MULT)}，越高越難中）",
            default=fmt_mult(parent.multiplier),
            max_length=7,
        )
        self.add_item(self.amount)
        self.add_item(self.mult)

    async def on_submit(self, interaction: discord.Interaction):
        async def refuse(msg: str):
            await interaction.response.send_message(msg, ephemeral=True)

        # 投注金額
        balance = await self.cog.get_balance(self.owner.id)
        raw = self.amount.value.strip().lower()
        bet = min(balance, GAMBLE_MAX_BET) if raw in ALL_IN_WORDS else parse_amount(raw)
        if bet is None or bet < 1:
            return await refuse("❌ 投注金額必須是大於 0 的整數。")
        if bet > GAMBLE_MAX_BET:
            return await refuse(f"❌ 單次最多只能下注 {fmt(GAMBLE_MAX_BET)}。")

        # 倍率
        mult = parse_multiplier(self.mult.value)
        if mult is None or not (GAMBLE_MIN_MULT <= mult <= GAMBLE_MAX_MULT):
            return await refuse(f"❌ 倍率必須是 {fmt_mult(GAMBLE_MIN_MULT)} ~ {fmt_mult(GAMBLE_MAX_MULT)} 之間的數字。")
        mult = mult.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)   # 最多兩位小數

        if gamble_payout(bet, mult) <= bet:
            return await refuse("❌ 這樣的獎金不會比投注金額多（金額太小或倍率太低），請提高投注金額或倍率。")

        result = await self.cog.gamble(self.owner.id, bet, mult)
        if result is None:
            balance = await self.cog.get_balance(self.owner.id)
            return await refuse(f"❌ 餘額不足！你目前只有 {fmt(balance)}。")
        won, payout, new_balance = result

        chance = win_chance(mult) * 100
        print(
            f"[C幣] {self.owner}（{self.owner.id}）賭 {bet} × {fmt_mult(mult)} 倍 "
            f"→ {'中獎 +' + str(payout - bet) if won else '沒中 -' + str(bet)}，餘額 {new_balance}"
        )
        if won:
            notice = (
                f"🎉 **中獎！** 投注 {fmt(bet)} × {fmt_mult(mult)} 倍\n"
                f"獎金 **{fmt(payout)}**（淨賺 {fmt(payout - bet)}）"
            )
        else:
            notice = (
                f"💥 **沒中…** 損失 {fmt(bet)}\n"
                f"（{fmt_mult(mult)} 倍的中獎機率是 {chance:.2f}%）"
            )

        # 換一個新面板顯示結果（沿用剛剛的倍率，方便連續再玩）
        view = GambleView(self.cog, self.owner, mult)
        view.source = self.parent.source
        self.parent.stop()
        await interaction.response.edit_message(content=notice, embed=await view.render(), view=view)

    async def on_error(self, interaction: discord.Interaction, error: Exception):
        traceback.print_exception(type(error), error, error.__traceback__)
        await safe_reply(interaction, "❌ 操作失敗，請稍後再試。如果餘額有異動，請按「查看餘額」確認。")


class GambleView(OwnerView):
    """先用下拉選單選倍率，再按「下注」輸入金額。"""

    def __init__(self, cog: "Coins", owner: discord.abc.User, multiplier: Decimal = Decimal("2")):
        super().__init__(cog, owner)
        self.multiplier = multiplier
        # 下拉選單在這裡建立（不是用裝飾器），讓每個面板的選項各自獨立
        self.pick_mult = discord.ui.Select(placeholder="🎚️ 選擇獎金倍率", options=mult_options(), min_values=1, max_values=1, row=0)
        self.pick_mult.callback = self.on_pick
        self.add_item(self.pick_mult)

    async def render(self) -> discord.Embed:
        balance = await self.cog.get_balance(self.owner.id)
        chance = win_chance(self.multiplier) * 100
        self.pick_mult.placeholder = f"🎚️ 目前倍率 {fmt_mult(self.multiplier)} 倍（可改選其他倍率）"
        embed = discord.Embed(
            title="🎲 賭C幣",
            description=(
                f"目前餘額：{fmt(balance)}\n\n"
                f"**獎金倍率：{fmt_mult(self.multiplier)} 倍**\n"
                f"**中獎機率：{chance:.2f}%**\n\n"
                "獎金 = 投注金額 × 倍率\n"
                "中獎：拿到獎金（已含本金）\n"
                "沒中：失去投注金額"
            ),
            color=discord.Color.red(),
        )
        embed.set_author(name=self.owner.display_name, icon_url=self.owner.display_avatar.url)
        embed.set_footer(text=f"倍率越高，中獎機率越低 · 單次最多下注 {GAMBLE_MAX_BET:,} · 請量力而為")
        return embed

    async def on_pick(self, interaction: discord.Interaction):
        self.multiplier = Decimal(self.pick_mult.values[0])
        await interaction.response.edit_message(content=None, embed=await self.render(), view=self)

    @discord.ui.button(label="下注", emoji="🎲", style=discord.ButtonStyle.success, row=1)
    async def place_bet(self, interaction: discord.Interaction, button: discord.ui.Button):
        balance = await self.cog.get_balance(self.owner.id)
        if balance < 1:
            return await interaction.response.send_message("❌ 你目前沒有 C幣可以下注。", ephemeral=True)
        await interaction.response.send_modal(GambleModal(self.cog, self.owner, self, balance))

    @discord.ui.button(label="返回", emoji="⬅️", style=discord.ButtonStyle.secondary, row=1)
    async def back(self, interaction: discord.Interaction, button: discord.ui.Button):
        panel = CoinPanel(self.cog, self.owner)
        panel.source = self.source
        self.stop()
        await interaction.response.edit_message(content=None, embed=await panel.render(), view=panel)


# ───────────────────────── Cog ─────────────────────────
class Coins(commands.Cog):
    # 給 admin.py 的後台面板使用
    EMOJI = COIN_EMOJI
    MAX_GRANT = MAX_GRANT

    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self._lock = asyncio.Lock()
        self.api: CoinAPI | None = None
        self._shared_ready = False

    @staticmethod
    def fmt(amount: int) -> str:
        return fmt(amount)

    async def cog_load(self):
        await self.bot.db.execute(
            "CREATE TABLE IF NOT EXISTS coins ("
            "user_id INTEGER PRIMARY KEY, balance INTEGER NOT NULL DEFAULT 0, last_daily TEXT)"
        )
        async with self.bot.db.execute("PRAGMA table_info(coins)") as cur:
            columns = {row[1] for row in await cur.fetchall()}
        if "last_mine" not in columns:
            await self.bot.db.execute("ALTER TABLE coins ADD COLUMN last_mine INTEGER")
        await self.bot.db.commit()

        try:
            self.api = CoinAPI.from_env()
        except CoinAPIError as error:
            print(f"[C幣] 共用服務設定錯誤，C幣操作暫停：{error}")
            return
        if self.api is None:
            print("[C幣] 尚未設定共用服務，C幣操作暫停；不會使用本地餘額替代。")
            return

        try:
            async with self.bot.db.execute(
                "SELECT user_id, balance, last_daily, last_mine FROM coins ORDER BY user_id"
            ) as cur:
                rows = await cur.fetchall()
            legacy_accounts = [
                {
                    "userId": str(int(user_id)),
                    "balance": int(balance),
                    "lastDaily": last_daily,
                    "lastMine": int(last_mine) if last_mine is not None else None,
                }
                for user_id, balance, last_daily, last_mine in rows
            ]
            inserted, ignored = await self.api.import_legacy(legacy_accounts)
            self._shared_ready = True
            print(f"[C幣] 共用帳本已就緒；舊帳戶匯入新增 {inserted}、保留既有 {ignored} 筆。")
        except Exception as error:
            # 若 D1 暫時不可用，保留舊 SQLite 資料供下次啟動重試，但禁止用它處理即時餘額。
            self._shared_ready = False
            print(f"[C幣] 共用帳本初始化失敗，C幣操作暫停；稍後重啟可安全重試：{type(error).__name__}")

    def _require_shared(self) -> CoinAPI:
        if not self.api or not self._shared_ready:
            raise CoinAPIError("共用 C 幣服務尚未就緒，請管理員檢查 bot API 設定與 D1 連線")
        return self.api

    async def get_account(self, user_id: int) -> tuple[int, str | None]:
        """回傳 (共用餘額, 上次簽到日期)。餘額只從權威 D1 讀取。"""
        account = await self._require_shared().account(user_id)
        return int(account.get("balance", 0)), account.get("lastDaily")

    async def get_balance(self, user_id: int) -> int:
        return (await self.get_account(user_id))[0]

    async def add_coins(self, user_id: int, amount: int, *, operation_id: str | None = None) -> int:
        """給使用者 C幣；operation_id 可讓礦場 outbox 安全重試同一筆入帳。"""
        if amount <= 0:
            raise ValueError("amount 必須大於 0")
        async with self._lock:
            result = await self._require_shared().operation(
                "add", user_id, amount=amount, idempotency_key=operation_id
            )
            if not result.get("success"):
                raise CoinAPIError("共用餘額已達安全上限，無法入帳")
            return int(result["balances"][str(user_id)])

    async def claim_daily(self, user_id: int) -> tuple[bool, int]:
        today = today_str()
        async with self._lock:
            result = await self._require_shared().operation(
                "daily", user_id, amount=DAILY_REWARD, today=today
            )
            return bool(result.get("success")), int(result["balances"][str(user_id)])

    async def transfer(self, from_id: int, to_id: int, amount: int) -> bool:
        if amount <= 0 or from_id == to_id:
            raise ValueError("轉帳金額必須大於 0，且不能轉給自己")
        async with self._lock:
            result = await self._require_shared().operation(
                "transfer", from_id, targetId=str(to_id), amount=amount
            )
            return bool(result.get("success"))

    async def gamble(self, user_id: int, bet: int, multiplier: Decimal) -> tuple[bool, int, int] | None:
        if bet <= 0:
            raise ValueError("bet 必須大於 0")
        payout = gamble_payout(bet, multiplier)
        won = _rng.random() < win_chance(multiplier)
        delta = payout - bet if won else -bet
        async with self._lock:
            result = await self._require_shared().operation(
                "gamble", user_id, bet=bet, delta=delta
            )
            if not result.get("success"):
                return None
            return won, payout, int(result["balances"][str(user_id)])

    async def mine_ready_at(self, user_id: int) -> int:
        account = await self._require_shared().account(user_id)
        last_mine = account.get("lastMine")
        if last_mine is None:
            return 0
        ready_at = int(last_mine) + MINE_COOLDOWN
        return ready_at if ready_at > time.time() else 0

    async def mine(self, user_id: int) -> tuple[list[dict], int, int] | None:
        drops = roll_mining()
        total = sum(drop["value"] for drop in drops)
        async with self._lock:
            result = await self._require_shared().operation("mine", user_id, amount=total)
            if not result.get("success"):
                return None
            return drops, total, int(result["balances"][str(user_id)])

    async def spend(self, user_id: int, amount: int, *, operation_id: str | None = None) -> bool:
        if amount <= 0:
            raise ValueError("amount 必須大於 0")
        async with self._lock:
            result = await self._require_shared().operation(
                "spend", user_id, amount=amount, idempotency_key=operation_id
            )
            return bool(result.get("success"))

    # ── 指令 ──
    @app_commands.command(name="coin", description="開啟 C幣面板（簽到、查看餘額、轉帳、賭C幣、挖礦）")
    @app_commands.guild_only()
    async def coin(self, interaction: discord.Interaction):
        if not self._shared_ready:
            return await interaction.response.send_message(
                "❌ 共用 C 幣服務尚未就緒；餘額功能已暫停，請管理員檢查 API 設定。", ephemeral=True
            )
        panel = CoinPanel(self, interaction.user)
        panel.source = interaction
        await interaction.response.send_message(embed=await panel.render(), view=panel, ephemeral=True)


async def setup(bot):
    await bot.add_cog(Coins(bot))
