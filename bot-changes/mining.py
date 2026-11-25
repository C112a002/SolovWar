"""
礦場系統（由 bot.py 自動載入，需在 coin.py 之後載入）

  /mining —— 開啟礦場面板（只有你自己看得到）：
           🏭 選擇工廠　　下拉選單選一種資源，進入該工廠的詳細面板
           🏗️ 建造　　　　花 C幣 蓋工廠（1 級）
           ⬆️ 升級　　　　花 C幣 升級工廠，最高 MAX_LEVEL 級，產量依等級等比例增加
           📦 領取　　　　手動工廠專用：把工廠裡存的成品賣成 C幣
           📦 全部領取　　一次領取所有手動工廠的成品

  工廠分兩種（由 RESOURCES 的 mode 決定，每種資源固定一種）：
     · 自動（AUTO）：產出會自動換成 C幣存入帳戶（背景任務約每 AUTO_TICK_SECONDS 秒結算一次）
     · 手動（MANUAL）：產出先存在工廠裡，最多存 STORAGE_HOURS 小時的量，存滿就停止生產，要自己領取

說明：
  · 產量是依「經過的時間」計算，不需要一直開著面板。機器人離線時產量照樣累積（自動工廠最多補算 MAX_OFFLINE_HOURS 小時）。
  · 成品的單價是固定的：入帳 C幣 = 整數單位數 × 單價；不足 1 單位的部分會留到下次。
  · 工廠狀態存在 bot.db 的 factories 表；所有 C幣讀寫都經 Worker D1。入帳使用本地 durable outbox 與冪等 operation ID，避免跨資料庫失敗時重複或遺失。
  · 想調整產量、單價、造價、升級費用、存放上限等，改下面的「設定」區即可。
"""

import asyncio
import time
import traceback
import uuid
from dataclasses import dataclass

import discord
from discord import app_commands
from discord.ext import commands, tasks

from coin import COIN_NAME, OwnerView, fmt   # 沿用 coin.py 的 C幣名稱、格式化與面板基底

# ═══════════════ 設定（可自行調整） ═══════════════
MAX_LEVEL = 10              # 工廠最高等級
UPGRADE_EXP = 1.3           # 升級費用：從 L 級升到 L+1 級要付「建造費 × L^UPGRADE_EXP」（越大升級越貴）
STORAGE_HOURS = 48          # 手動工廠最多存放幾小時的產量，存滿就停止生產
MAX_OFFLINE_HOURS = 24      # 自動工廠離線時，最多補算幾小時的產量
AUTO_TICK_SECONDS = 60      # 自動工廠多久結算、入帳一次（秒）
VIEW_TIMEOUT = 300          # 面板閒置幾秒後自動停用按鈕

AUTO = "auto"               # 自動入帳
MANUAL = "manual"           # 手動領取


@dataclass(frozen=True)
class Resource:
    key: str            # 代號（存進資料庫用，不可重複）
    name: str           # 資源名稱
    factory: str        # 工廠名稱
    icon: str           # 圖示
    unit: str           # 單位
    price: int          # 每單位換成幾枚 C幣（單價固定）
    rate: float         # 1 級工廠每小時產出幾單位（等級越高，產量等比例增加）
    build_cost: int     # 建造費（1 級）；升級費用由 upgrade_cost() 依 UPGRADE_EXP 計算
    mode: str           # AUTO（自動入帳）或 MANUAL（手動領取）


RESOURCES = (
    #  代號        資源      工廠名稱       圖示   單位          單價  產量/時  建造費  模式
    Resource("coal",   "煤礦",   "煤礦工廠",   "🪨", "噸",          1,   4.0,   600,  MANUAL),
    Resource("iron",   "鐵",     "鐵礦工廠",   "🔩", "噸",          2,   2.0,   600,  AUTO),
    Resource("gas",    "天然氣", "天然氣工廠", "🔥", "千立方公尺",  3,   1.5,   700,  AUTO),
    Resource("oil",    "石油",   "石油工廠",   "🛢️", "桶",          4,   1.2,   750,  AUTO),
    Resource("copper", "銅",     "銅礦工廠",   "🟤", "公斤",        3,   1.5,   700,  MANUAL),
    Resource("tin",    "錫",     "錫礦工廠",   "🥫", "公斤",        8,   0.6,   800,  AUTO),
    Resource("silver", "銀",     "銀礦工廠",   "🥈", "公斤",       25,   0.2,   900,  MANUAL),
    Resource("gold",   "金",     "金礦工廠",   "🥇", "公克",       30,   0.16,  900,  MANUAL),
    Resource("uranium", "鈾",    "鈾礦工廠",   "☢️", "磅",         40,   0.12, 1000,  MANUAL),
)
# ═══════════════════════════════════════════════════

RESOURCE_BY_KEY = {r.key: r for r in RESOURCES}


# ───────────────────────── 純計算（不碰資料庫） ─────────────────────────
def upgrade_cost(res: Resource, level: int) -> int:
    """從 level 級升到 level+1 級要花多少 C幣（level ≥ 1）。"""
    return round(res.build_cost * level ** UPGRADE_EXP)


def output_per_hour(res: Resource, level: int) -> float:
    """目前等級每小時產出幾單位。"""
    return res.rate * level


def capacity(res: Resource, level: int) -> float:
    """手動工廠的存放上限（單位）。"""
    return output_per_hour(res, level) * STORAGE_HOURS


def accrue(res: Resource, level: int, stored: float, updated_at: float, now: float) -> float:
    """依經過的時間，把產量加進 stored（尚未入帳的單位數，可含小數）。"""
    limit_hours = MAX_OFFLINE_HOURS if res.mode == AUTO else STORAGE_HOURS
    hours = min(max(0.0, now - updated_at) / 3600, limit_hours)
    stored += output_per_hour(res, level) * hours
    if res.mode == MANUAL:
        stored = min(stored, capacity(res, level))
    return stored


def fmt_num(x: float) -> str:
    """2.0 → '2'；0.12 → '0.12'；1.5 → '1.5'"""
    return f"{x:.2f}".rstrip("0").rstrip(".")


def mode_text(res: Resource) -> str:
    return "⚡ 自動入帳" if res.mode == AUTO else "📦 手動領取"


def mode_desc(res: Resource) -> str:
    if res.mode == AUTO:
        return f"⚡ **自動入帳**：產出會持續累積，約每 {AUTO_TICK_SECONDS} 秒換成 {COIN_NAME} 存進你的帳戶，不用手動領取。"
    return f"📦 **手動領取**：產出先存在工廠裡（最多存 {STORAGE_HOURS} 小時的量），要自己按「領取」才會換成 {COIN_NAME}。"


def factory_line(res: Resource, level: int, stored: float) -> str:
    """總覽面板中，每座工廠的一行（兩行）文字。"""
    if level == 0:
        return f"{res.icon} **{res.factory}**　🔒 未建造（建造費 {res.build_cost:,} {COIN_NAME}）"
    per_hour = output_per_hour(res, level)
    if res.mode == AUTO:
        return (
            f"{res.icon} **{res.factory}**　Lv.{level}　⚡ 自動入帳\n"
            f"　└ 每小時 {fmt_num(per_hour)} {res.unit} ≈ {fmt_num(per_hour * res.price)} {COIN_NAME}"
        )
    ready = int(stored)
    return (
        f"{res.icon} **{res.factory}**　Lv.{level}　📦 手動領取\n"
        f"　└ 已存 {ready} / {fmt_num(capacity(res, level))} {res.unit}（可領 {ready * res.price:,} {COIN_NAME}）"
    )


# ───────────────────────── 總覽面板 ─────────────────────────
class MiningPanel(OwnerView):
    def __init__(self, cog: "Mining", owner: discord.abc.User):
        super().__init__(cog, owner)
        self.pick = discord.ui.Select(
            placeholder="🏭 選擇要查看的工廠",
            options=[
                discord.SelectOption(
                    label=r.factory,
                    value=r.key,
                    emoji=r.icon,
                    description=f"{mode_text(r)}　{r.price:,} {COIN_NAME}/{r.unit}",
                )
                for r in RESOURCES
            ],
            min_values=1,
            max_values=1,
            row=0,
        )
        self.pick.callback = self.on_pick
        self.add_item(self.pick)

    async def render(self) -> discord.Embed:
        state = await self.cog.refresh(self.owner.id)
        balance = await self.cog.coins.get_balance(self.owner.id)

        lines = []
        ready_value = 0
        for res in RESOURCES:
            level, stored = state.get(res.key, (0, 0.0))
            if res.mode == MANUAL and level:
                ready_value += int(stored) * res.price
            lines.append(factory_line(res, level, stored))

        self.collect_all_btn.label = f"全部領取（可領 {ready_value:,} {COIN_NAME}）"
        self.collect_all_btn.disabled = ready_value < 1

        embed = discord.Embed(
            title="🏭 礦場總覽",
            description=f"**目前餘額**\n{fmt(balance)}\n\n" + "\n".join(lines),
            color=discord.Color.dark_orange(),
        )
        embed.set_footer(
            text=f"自動工廠約每 {AUTO_TICK_SECONDS} 秒入帳 · 手動工廠存滿後會停止生產 · 閒置 {VIEW_TIMEOUT // 60} 分鐘後停用按鈕"
        )
        return embed

    async def on_pick(self, interaction: discord.Interaction):
        res = RESOURCE_BY_KEY[self.pick.values[0]]
        view = FactoryView(self.cog, self.owner, res)
        view.source = self.source
        self.stop()
        await interaction.response.edit_message(content=None, embed=await view.render(), view=view)

    @discord.ui.button(label="全部領取", emoji="📦", style=discord.ButtonStyle.success, row=1)
    async def collect_all_btn(self, interaction: discord.Interaction, button: discord.ui.Button):
        keys = {r.key for r in RESOURCES if r.mode == MANUAL}
        sold = await self.cog.collect(self.owner.id, keys)
        if not sold:
            return await interaction.response.send_message(
                "⏳ 手動工廠目前還沒有可領取的成品（至少要 1 單位）。", ephemeral=True
            )
        total = sum(credit for _, credit in sold.values())
        lines = [
            f"{RESOURCE_BY_KEY[k].icon} {RESOURCE_BY_KEY[k].name}　{units} {RESOURCE_BY_KEY[k].unit}（+{credit:,} {COIN_NAME}）"
            for k, (units, credit) in sold.items()
        ]
        notice = "✅ 全部領取完成！\n" + "\n".join(lines) + f"\n**共 +{total:,} {COIN_NAME}**"
        await interaction.response.edit_message(content=notice, embed=await self.render(), view=self)

    @discord.ui.button(label="重新整理", emoji="🔄", style=discord.ButtonStyle.primary, row=1)
    async def refresh_btn(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.edit_message(content=None, embed=await self.render(), view=self)


# ───────────────────────── 單一工廠面板 ─────────────────────────
class FactoryView(OwnerView):
    def __init__(self, cog: "Mining", owner: discord.abc.User, res: Resource):
        super().__init__(cog, owner)
        self.res = res

    async def render(self) -> discord.Embed:
        res = self.res
        state = await self.cog.refresh(self.owner.id)
        level, stored = state.get(res.key, (0, 0.0))
        balance = await self.cog.coins.get_balance(self.owner.id)

        # 建造 / 升級按鈕
        if level == 0:
            self.build_btn.label = f"建造（{res.build_cost:,} {COIN_NAME}）"
            self.build_btn.disabled = False
        elif level >= MAX_LEVEL:
            self.build_btn.label = "已達最高等級"
            self.build_btn.disabled = True
        else:
            self.build_btn.label = f"升級到 Lv.{level + 1}（{upgrade_cost(res, level):,} {COIN_NAME}）"
            self.build_btn.disabled = False

        # 領取按鈕
        if level == 0:
            self.collect_btn.label = "尚未建造"
            self.collect_btn.disabled = True
        elif res.mode == AUTO:
            self.collect_btn.label = "自動入帳中"
            self.collect_btn.disabled = True
        else:
            ready = int(stored)
            self.collect_btn.label = f"領取（{ready} {res.unit}）"
            self.collect_btn.disabled = ready < 1

        status = "🔒 尚未建造" if level == 0 else f"Lv.{level} / {MAX_LEVEL}" + ("（滿級）" if level >= MAX_LEVEL else "")
        embed = discord.Embed(
            title=f"{res.icon} {res.factory}",
            description=f"**目前餘額**：{fmt(balance)}\n**工廠狀態**：{status}",
            color=discord.Color.dark_gold(),
        )
        embed.add_field(name="運作方式", value=mode_desc(res), inline=False)
        embed.add_field(name="單位價格", value=f"1 {res.unit} = {res.price:,} {COIN_NAME}", inline=True)

        if level:
            per_hour = output_per_hour(res, level)
            embed.add_field(
                name="目前產量",
                value=f"每小時 {fmt_num(per_hour)} {res.unit} ≈ **{fmt_num(per_hour * res.price)} {COIN_NAME}**",
                inline=False,
            )
            if res.mode == MANUAL:
                ready = int(stored)
                embed.add_field(
                    name="工廠儲存",
                    value=(
                        f"已存 {ready} / {fmt_num(capacity(res, level))} {res.unit}"
                        f"（可領 {ready * res.price:,} {COIN_NAME}）\n存滿就停止生產，記得回來領取。"
                    ),
                    inline=False,
                )
            if level < MAX_LEVEL:
                embed.add_field(
                    name="下一級",
                    value=(
                        f"升到 Lv.{level + 1}：費用 {upgrade_cost(res, level):,} {COIN_NAME}，"
                        f"產量提升到每小時 {fmt_num(output_per_hour(res, level + 1))} {res.unit}"
                    ),
                    inline=False,
                )
        else:
            embed.add_field(
                name="建造後（1 級）",
                value=f"每小時 {fmt_num(output_per_hour(res, 1))} {res.unit} ≈ {fmt_num(output_per_hour(res, 1) * res.price)} {COIN_NAME}",
                inline=False,
            )

        embed.set_footer(text=f"閒置 {VIEW_TIMEOUT // 60} 分鐘後停用按鈕 · 只有你看得到這個面板")
        return embed

    @discord.ui.button(label="建造", emoji="🏗️", style=discord.ButtonStyle.success, row=0)
    async def build_btn(self, interaction: discord.Interaction, button: discord.ui.Button):
        ok, msg = await self.cog.build(self.owner.id, self.res)
        if not ok:
            return await interaction.response.send_message(msg, ephemeral=True)
        await interaction.response.edit_message(content=msg, embed=await self.render(), view=self)

    @discord.ui.button(label="領取", emoji="📦", style=discord.ButtonStyle.primary, row=0)
    async def collect_btn(self, interaction: discord.Interaction, button: discord.ui.Button):
        sold = await self.cog.collect(self.owner.id, {self.res.key})
        if self.res.key not in sold:
            return await interaction.response.send_message(
                "⏳ 工廠裡還沒有可領取的成品（至少要 1 單位）。", ephemeral=True
            )
        units, credit = sold[self.res.key]
        notice = f"✅ 領取 {units} {self.res.unit}{self.res.name}，換得 +{credit:,} {COIN_NAME}"
        await interaction.response.edit_message(content=notice, embed=await self.render(), view=self)

    @discord.ui.button(label="返回", emoji="⬅️", style=discord.ButtonStyle.secondary, row=1)
    async def back_btn(self, interaction: discord.Interaction, button: discord.ui.Button):
        panel = MiningPanel(self.cog, self.owner)
        panel.source = self.source
        self.stop()
        await interaction.response.edit_message(content=None, embed=await panel.render(), view=panel)


# ───────────────────────── Cog ─────────────────────────
class Mining(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self._lock = asyncio.Lock()   # 所有會改動工廠或 C幣的操作一次只跑一個
        self._recovery_task: asyncio.Task | None = None

    @property
    def coins(self):
        """C幣系統（coin.py 的 Coins cog）。"""
        coins = self.bot.get_cog("Coins")
        if coins is None:
            raise RuntimeError("找不到 Coins 模組，請確認 coin.py 已先載入")
        return coins

    async def cog_load(self):
        await self.bot.db.execute(
            "CREATE TABLE IF NOT EXISTS factories ("
            "user_id INTEGER NOT NULL, resource TEXT NOT NULL, "
            "level INTEGER NOT NULL DEFAULT 0, stored REAL NOT NULL DEFAULT 0, "
            "updated_at REAL NOT NULL, PRIMARY KEY (user_id, resource))"
        )
        await self.bot.db.execute(
            "CREATE TABLE IF NOT EXISTS coin_outbox ("
            "operation_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, "
            "amount INTEGER NOT NULL CHECK (amount > 0), created_at REAL NOT NULL)"
        )
        await self.bot.db.execute(
            "CREATE TABLE IF NOT EXISTS coin_build_operations ("
            "operation_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, resource TEXT NOT NULL, "
            "target_level INTEGER NOT NULL, amount INTEGER NOT NULL CHECK (amount > 0), "
            "created_at REAL NOT NULL, status TEXT NOT NULL DEFAULT 'pending' "
            "CHECK (status IN ('pending', 'done', 'declined')))"
        )
        await self.bot.db.commit()
        self._recovery_task = asyncio.create_task(self._recover_pending_builds())
        self.auto_tick.start()

    def cog_unload(self):
        self.auto_tick.cancel()
        if self._recovery_task and not self._recovery_task.done():
            self._recovery_task.cancel()

    async def _flush_coin_outbox(self, user_id: int):
        """把已與工廠更新同一 SQLite transaction 寫入的入帳逐筆送到 D1。"""
        db = self.bot.db
        async with db.execute(
            "SELECT operation_id, amount FROM coin_outbox WHERE user_id = ? ORDER BY created_at",
            (user_id,),
        ) as cur:
            pending = await cur.fetchall()
        for operation_id, amount in pending:
            await self.coins.add_coins(user_id, int(amount), operation_id=operation_id)
            await db.execute("DELETE FROM coin_outbox WHERE operation_id = ?", (operation_id,))
            await db.commit()

    async def _settle_build_charge(self, row) -> bool:
        """以同一冪等 ID 重試扣款；成功後在 SQLite 單一交易套用工廠狀態。"""
        operation_id, user_id, resource, target_level, amount = row
        if not await self.coins.spend(int(user_id), int(amount), operation_id=operation_id):
            await self.bot.db.execute(
                "UPDATE coin_build_operations SET status = 'declined' "
                "WHERE operation_id = ? AND status = 'pending'", (operation_id,)
            )
            await self.bot.db.commit()
            return False

        db = self.bot.db
        now = time.time()
        try:
            if int(target_level) == 1:
                await db.execute(
                    "INSERT OR IGNORE INTO factories "
                    "(user_id, resource, level, stored, updated_at) VALUES (?, ?, 1, 0, ?)",
                    (user_id, resource, now),
                )
                async with db.execute(
                    "SELECT level FROM factories WHERE user_id = ? AND resource = ?",
                    (user_id, resource),
                ) as cur:
                    current = await cur.fetchone()
                if not current or int(current[0]) != 1:
                    raise RuntimeError("建造交易的工廠狀態不符")
            else:
                cur = await db.execute(
                    "UPDATE factories SET level = ?, updated_at = ? "
                    "WHERE user_id = ? AND resource = ? AND level = ?",
                    (target_level, now, user_id, resource, int(target_level) - 1),
                )
                if cur.rowcount != 1:
                    async with db.execute(
                        "SELECT level FROM factories WHERE user_id = ? AND resource = ?",
                        (user_id, resource),
                    ) as check_cur:
                        current = await check_cur.fetchone()
                    if not current or int(current[0]) != int(target_level):
                        raise RuntimeError("升級交易的工廠狀態不符")
            await db.execute(
                "UPDATE coin_build_operations SET status = 'done' "
                "WHERE operation_id = ? AND status = 'pending'", (operation_id,)
            )
            await db.commit()
            return True
        except Exception:
            await db.rollback()
            raise

    async def _recover_pending_builds(self):
        """啟動時恢復未完成扣款；逾時時保留 pending，供下次使用相同冪等 ID 重試。"""
        db = self.bot.db
        async with db.execute(
            "SELECT operation_id, user_id, resource, target_level, amount "
            "FROM coin_build_operations WHERE status = 'pending' ORDER BY created_at"
        ) as cur:
            rows = await cur.fetchall()
        for row in rows:
            try:
                async with self._lock:
                    await self._settle_build_charge(row)
            except asyncio.CancelledError:
                raise
            except Exception:
                print("[礦場] 尚有建造扣款待恢復；下次啟動或操作時會用同一交易 ID 重試。")

    # ── 核心結算 ──
    async def _sync(self, user_id: int, collect: set[str] | None = None):
        """把使用者所有工廠結算到現在（呼叫前必須持有 self._lock）。

        · 自動工廠：產出的整數單位直接換成 C幣入帳。
        · collect 內的手動工廠：整數單位賣成 C幣入帳；其他手動工廠只更新已存數量。
        回傳 (sold, state)：
          sold  = {資源代號: (賣出的單位數, 入帳的 C幣)}
          state = {資源代號: (等級, 已存的單位數)}
        """
        db = self.bot.db
        await self._flush_coin_outbox(user_id)
        now = time.time()
        async with db.execute(
            "SELECT resource, level, stored, updated_at FROM factories WHERE user_id = ? AND level > 0",
            (user_id,),
        ) as cur:
            rows = await cur.fetchall()

        sold: dict[str, tuple[int, int]] = {}
        state: dict[str, tuple[int, float]] = {}
        total = 0
        try:
            for key, level, stored, updated_at in rows:
                res = RESOURCE_BY_KEY[key]
                stored = accrue(res, level, stored, updated_at, now)
                if res.mode == AUTO or (collect and key in collect):
                    units = int(stored)
                    if units:
                        stored -= units
                        credit = units * res.price
                        sold[key] = (units, credit)
                        total += credit
                state[key] = (level, stored)
                await db.execute(
                    "UPDATE factories SET stored = ?, updated_at = ? WHERE user_id = ? AND resource = ?",
                    (stored, now, user_id, key),
                )
            if total:
                await db.execute(
                    "INSERT INTO coin_outbox (operation_id, user_id, amount, created_at) VALUES (?, ?, ?, ?)",
                    (uuid.uuid4().hex, user_id, total, now),
                )
            await db.commit()
        except Exception:
            await db.rollback()
            raise
        await self._flush_coin_outbox(user_id)
        return sold, state

    # ── 對外操作（各自取得鎖） ──
    async def refresh(self, user_id: int) -> dict[str, tuple[int, float]]:
        """結算到現在（自動工廠會入帳），回傳 {資源代號: (等級, 已存單位數)}。"""
        async with self._lock:
            _, state = await self._sync(user_id)
        return state

    async def collect(self, user_id: int, keys: set[str]) -> dict[str, tuple[int, int]]:
        """領取指定的手動工廠成品。回傳 {資源代號: (單位數, 入帳的 C幣)}，只含真的有賣出的工廠。"""
        async with self._lock:
            sold, _ = await self._sync(user_id, collect=keys)
        result = {k: v for k, v in sold.items() if RESOURCE_BY_KEY[k].mode == MANUAL}
        for key, (units, credit) in result.items():
            print(f"[礦場] {user_id} 領取 {RESOURCE_BY_KEY[key].factory} {units} 單位，+{credit} C幣")
        return result

    async def build(self, user_id: int, res: Resource) -> tuple[bool, str]:
        """建造（1 級）或升級工廠。回傳 (是否成功, 給使用者看的訊息)。"""
        async with self._lock:
            db = self.bot.db
            async with db.execute(
                "SELECT operation_id, user_id, resource, target_level, amount "
                "FROM coin_build_operations WHERE user_id = ? AND status = 'pending' "
                "ORDER BY created_at", (user_id,)
            ) as cur:
                pending = await cur.fetchall()
            if pending:
                recovered = False
                for row in pending:
                    recovered = await self._settle_build_charge(row) or recovered
                if recovered:
                    return True, "✅ 已恢復上一筆尚未完成的建造交易，請重新整理礦場面板確認工廠狀態。"
                return False, "❌ 上一筆建造交易因餘額不足未扣款；請確認餘額後重新操作。"

            _, state = await self._sync(user_id)
            level = state.get(res.key, (0, 0.0))[0]
            if level >= MAX_LEVEL:
                return False, "❌ 這座工廠已經是最高等級了。"

            cost = res.build_cost if level == 0 else upgrade_cost(res, level)
            action = "建造" if level == 0 else f"升級到 Lv.{level + 1}"
            charge_id = uuid.uuid4().hex
            target_level = level + 1
            await db.execute(
                "INSERT INTO coin_build_operations "
                "(operation_id, user_id, resource, target_level, amount, created_at, status) "
                "VALUES (?, ?, ?, ?, ?, ?, 'pending')",
                (charge_id, user_id, res.key, target_level, cost, time.time()),
            )
            await db.commit()
            try:
                settled = await self._settle_build_charge(
                    (charge_id, user_id, res.key, target_level, cost)
                )
            except Exception:
                return False, "⚠️ 交易回應暫時無法確認；建造請求已安全保存，請稍後再操作，系統會以同一交易編號恢復。"

            if not settled:
                coins = self.coins
                balance = await coins.get_balance(user_id)
                return False, f"❌ 餘額不足！{action}需要 {fmt(cost)}，你目前只有 {fmt(balance)}。"

        print(f"[礦場] {user_id} {action} {res.factory}，花費 {cost} C幣")
        return True, f"✅ {action}成功！花費 {fmt(cost)}"

    # ── 自動工廠背景結算 ──
    @tasks.loop(seconds=AUTO_TICK_SECONDS)
    async def auto_tick(self):
        try:
            auto_keys = [r.key for r in RESOURCES if r.mode == AUTO]
            marks = ",".join("?" * len(auto_keys))
            async with self.bot.db.execute(
                f"SELECT DISTINCT user_id FROM factories WHERE level > 0 AND resource IN ({marks})",
                auto_keys,
            ) as cur:
                user_ids = [row[0] for row in await cur.fetchall()]
            for user_id in user_ids:
                try:
                    async with self._lock:
                        await self._sync(user_id)
                except Exception:
                    traceback.print_exc()
        except Exception:
            traceback.print_exc()

    # ── 指令 ──
    @app_commands.command(name="mining", description="開啟礦場面板（石油、煤礦、天然氣、金銀鐵銅錫鈾工廠）")
    @app_commands.guild_only()
    async def mining(self, interaction: discord.Interaction):
        panel = MiningPanel(self, interaction.user)
        panel.source = interaction
        await interaction.response.send_message(embed=await panel.render(), view=panel, ephemeral=True)


async def setup(bot):
    if bot.get_cog("Coins") is None:
        raise RuntimeError("mining.py 需要 coin.py，請先在 bot.py 載入 coin")
    await bot.add_cog(Mining(bot))
