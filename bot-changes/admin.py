"""
管理後台（由 bot.py 自動載入）

  /backend —— 只有 ADMIN_IDS 名單內的 Discord 使用者才能開啟管理後台。
  （Discord 規定斜線指令名稱只能是小寫，所以 /Backend 會是 /backend，輸入時不分大小寫也找得到）

後台功能：總覽、伺服器列表、提醒列表、發送公告、修改機器人狀態、
          資料清理（等級／警告）、自動回覆（新增／列表／刪除）、
          發放 C幣（給自己或指定使用者）、
          AI 個性（自訂 /ask 的 system_instruction，存進資料庫、立即生效）、
          重新載入擴充、同步指令、關閉機器人

自動回覆：管理員在後台新增「觸發文字 → 回覆內容」。之後任何人發的訊息只要「包含」
          觸發文字（不分大小寫），機器人就會用回覆的方式送出預先設定好的內容。
"""

import asyncio
import datetime
import os
import platform
import time
import traceback
from typing import Awaitable, Callable

import discord
from discord import app_commands
from discord.ext import commands

from coin import COIN_EMOJI, parse_amount  # C幣表情符號與數字解析（coin.py）
from coin_api import CoinAPIError

# ═══════════════ 在這裡填入管理員的 Discord 使用者 ID ═══════════════
# 取得方式：Discord 設定 → 進階 → 開啟「開發者模式」
#           → 對自己的頭像按右鍵 →「複製使用者 ID」
# 可填多個，用逗號分隔。名單是空的時，沒有任何人能開啟後台。
ADMIN_IDS = [
     1096316400529842206,
     1267780618985537579,   # ← 取消註解，換成你自己的 ID
]
# ═══════════════════════════════════════════════════════════════════

DB_PATH = "bot.db"      # 要和 bot.py 的 DB_PATH 一致
VIEW_TIMEOUT = 300      # 後台面板閒置幾秒後自動停用按鈕
NO_PERMISSION = "❌ 你沒有權限使用管理後台。"
ACTIVITY_TYPES = {
    "playing": discord.ActivityType.playing,
    "listening": discord.ActivityType.listening,
    "watching": discord.ActivityType.watching,
    "competing": discord.ActivityType.competing,
}
CLEANUP_TABLES = {"levels": "等級", "warnings": "警告"}  # 可清理的資料表
AUTO_REPLY_COOLDOWN = 3   # 同一個人觸發同一條自動回覆的冷卻秒數（避免洗版）
AUTO_REPLY_CHANNEL_COOLDOWN = 2   # 同一個頻道兩次自動回覆之間至少隔幾秒（熱門頻道也不會一口氣打出大量請求）
AUTO_REPLY_LIST_MAX = 25  # 列表／刪除選單最多顯示幾筆（Discord 下拉選單上限 25）


def is_admin(user_id: int) -> bool:
    return user_id in {int(x) for x in ADMIN_IDS}


async def reply(interaction: discord.Interaction, content: str, **kwargs):
    """不管有沒有回應過，都用悄悄話回覆。回覆失敗（被限速、互動已過期）時只記一行，不再丟出例外。"""
    try:
        if interaction.response.is_done():
            await interaction.followup.send(content, ephemeral=True, **kwargs)
        else:
            await interaction.response.send_message(content, ephemeral=True, **kwargs)
    except (discord.HTTPException, discord.RateLimited, discord.InteractionResponded) as error:
        print(f"[後台] 回覆失敗：{type(error).__name__}: {str(error)[:120]}")


async def check_admin(interaction: discord.Interaction) -> bool:
    if is_admin(interaction.user.id):
        return True
    print(f"[後台] 拒絕：{interaction.user}（{interaction.user.id}）嘗試使用後台")
    await reply(interaction, NO_PERMISSION)
    return False


# ───────────────────────── 共用基底（每次互動都再驗證一次白名單） ─────────────────────────
class AdminView(discord.ui.View):
    def __init__(self, timeout: float | None = VIEW_TIMEOUT):
        super().__init__(timeout=timeout)
        self.source: discord.Interaction | None = None  # 用來在逾時時停用按鈕

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return await check_admin(interaction)

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
        await reply(interaction, "❌ 操作失敗，詳細原因請看終端機。")


class AdminModal(discord.ui.Modal):
    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return await check_admin(interaction)

    async def on_error(self, interaction: discord.Interaction, error: Exception):
        traceback.print_exception(type(error), error, error.__traceback__)
        message = (
            "❌ 共用 C 幣服務暫時無法確認發放結果，請先重新整理餘額再重試。"
            if isinstance(error, CoinAPIError)
            else "❌ 操作失敗，詳細原因請看終端機。"
        )
        await reply(interaction, message)


class ConfirmView(AdminView):
    """危險操作的二次確認。action 回傳要顯示的結果文字。"""

    def __init__(self, action: Callable[[], Awaitable[str]]):
        super().__init__(timeout=60)
        self.action = action

    @discord.ui.button(label="確認執行", emoji="⚠️", style=discord.ButtonStyle.danger)
    async def confirm(self, interaction: discord.Interaction, button: discord.ui.Button):
        self.stop()
        await interaction.response.edit_message(content="⏳ 處理中…", embed=None, view=None)
        result = await self.action()
        await interaction.edit_original_response(content=result)

    @discord.ui.button(label="取消", style=discord.ButtonStyle.secondary)
    async def cancel(self, interaction: discord.Interaction, button: discord.ui.Button):
        self.stop()
        await interaction.response.edit_message(content="已取消。", embed=None, view=None)


# ───────────────────────── Modal ─────────────────────────
class AnnounceModal(AdminModal, title="📢 發送公告"):
    channel_id = discord.ui.TextInput(label="頻道 ID", placeholder="對頻道按右鍵 → 複製頻道 ID", max_length=25)
    content = discord.ui.TextInput(label="公告內容", style=discord.TextStyle.paragraph, max_length=1800)

    async def on_submit(self, interaction: discord.Interaction):
        try:
            cid = int(self.channel_id.value.strip())
        except ValueError:
            return await interaction.response.send_message("❌ 頻道 ID 必須是數字。", ephemeral=True)

        channel = interaction.client.get_channel(cid)
        if channel is None:
            try:
                channel = await interaction.client.fetch_channel(cid)
            except discord.HTTPException:
                channel = None
        if not isinstance(channel, discord.abc.Messageable):
            return await interaction.response.send_message("❌ 找不到這個頻道，或它不能發訊息。", ephemeral=True)

        embed = discord.Embed(
            title="📢 公告",
            description=self.content.value,
            color=discord.Color.orange(),
            timestamp=discord.utils.utcnow(),
        )
        try:
            await channel.send(embed=embed, allowed_mentions=discord.AllowedMentions.none())
        except discord.Forbidden:
            return await interaction.response.send_message("❌ 我在該頻道沒有發言權限。", ephemeral=True)
        print(f"[後台] {interaction.user}（{interaction.user.id}）發送公告到頻道 {cid}")
        await interaction.response.send_message(f"✅ 已發送公告到 <#{cid}>。", ephemeral=True)


class StatusModal(AdminModal, title="🎭 修改機器人狀態"):
    kind = discord.ui.TextInput(
        label="類型", default="playing", placeholder="playing / listening / watching / competing", max_length=10
    )
    text = discord.ui.TextInput(label="狀態文字", placeholder="例如：/help 查看指令", max_length=100)

    async def on_submit(self, interaction: discord.Interaction):
        kind = self.kind.value.strip().lower()
        if kind not in ACTIVITY_TYPES:
            return await interaction.response.send_message(
                "❌ 類型只能是 playing / listening / watching / competing。", ephemeral=True
            )
        activity = discord.Activity(type=ACTIVITY_TYPES[kind], name=self.text.value.strip())
        await interaction.client.change_presence(activity=activity)
        print(f"[後台] {interaction.user}（{interaction.user.id}）修改狀態：{kind} {self.text.value}")
        await interaction.response.send_message("✅ 狀態已更新（機器人重啟後會恢復預設）。", ephemeral=True)


class CleanupModal(AdminModal, title="🗑️ 資料清理"):
    guild_id = discord.ui.TextInput(label="伺服器 ID", placeholder="要清理哪個伺服器的資料", max_length=25)
    kind = discord.ui.TextInput(label="類型：levels（等級）或 warnings（警告）", max_length=10)

    async def on_submit(self, interaction: discord.Interaction):
        kind = self.kind.value.strip().lower()
        if kind not in CLEANUP_TABLES:
            return await interaction.response.send_message("❌ 類型只能是 levels 或 warnings。", ephemeral=True)
        try:
            gid = int(self.guild_id.value.strip())
        except ValueError:
            return await interaction.response.send_message("❌ 伺服器 ID 必須是數字。", ephemeral=True)

        db = interaction.client.db
        table = kind  # 只會是上面白名單內的值，可安全放進 SQL
        async with db.execute(f"SELECT COUNT(*) FROM {table} WHERE guild_id = ?", (gid,)) as cur:
            count = (await cur.fetchone())[0]
        if count == 0:
            return await interaction.response.send_message("這個伺服器沒有這類資料，不需要清理。", ephemeral=True)

        admin = interaction.user

        async def do_cleanup() -> str:
            await db.execute(f"DELETE FROM {table} WHERE guild_id = ?", (gid,))
            await db.commit()
            print(f"[後台] {admin}（{admin.id}）清除伺服器 {gid} 的 {table}（{count} 筆）")
            return f"🧽 已刪除伺服器 `{gid}` 的 {count} 筆{CLEANUP_TABLES[kind]}資料。"

        view = ConfirmView(do_cleanup)
        view.source = interaction
        await interaction.response.send_message(
            f"⚠️ 即將刪除伺服器 `{gid}` 的 **{count}** 筆{CLEANUP_TABLES[kind]}資料，**無法復原**。",
            view=view,
            ephemeral=True,
        )


class GiveCoinModal(AdminModal, title="💰 發放 C幣"):
    user_id = discord.ui.TextInput(
        label="使用者 ID（留空＝給自己）",
        placeholder="對使用者按右鍵 → 複製使用者 ID",
        required=False,
        max_length=25,
    )
    amount = discord.ui.TextInput(label="發放數量", placeholder="正整數，例如 1000", max_length=15)

    async def on_submit(self, interaction: discord.Interaction):
        coins = interaction.client.get_cog("Coins")
        if coins is None:
            return await interaction.response.send_message("❌ C幣模組尚未載入。", ephemeral=True)

        raw_id = self.user_id.value.strip()
        try:
            target_id = int(raw_id) if raw_id else interaction.user.id
        except ValueError:
            return await interaction.response.send_message("❌ 使用者 ID 必須是數字。", ephemeral=True)
        amount = parse_amount(self.amount.value)
        if amount is None or not 1 <= amount <= coins.MAX_GRANT:
            return await interaction.response.send_message(
                f"❌ 數量必須是 1 ～ {coins.MAX_GRANT:,} 的整數。", ephemeral=True
            )

        await interaction.response.defer(ephemeral=True, thinking=True)
        if target_id != interaction.user.id:  # 發給別人時，先確認這個 ID 真的是使用者，避免打錯字發到空氣裡
            try:
                target = await interaction.client.fetch_user(target_id)
            except discord.HTTPException:
                return await interaction.followup.send("❌ 找不到這個使用者 ID，請確認有沒有複製錯。", ephemeral=True)
            if target.bot:
                return await interaction.followup.send("❌ 不能發放 C幣給機器人。", ephemeral=True)

        new_balance = await coins.add_coins(target_id, amount)
        print(f"[後台] {interaction.user}（{interaction.user.id}）發放 {amount} C幣給 {target_id}，新餘額 {new_balance}")
        await interaction.followup.send(
            f"✅ 已發放 {coins.fmt(amount)} 給 <@{target_id}>（`{target_id}`）\n"
            f"對方現在有 {coins.fmt(new_balance)}",
            ephemeral=True,
            allowed_mentions=discord.AllowedMentions.none(),
        )


class AIPersonaModal(AdminModal, title="🧠 /ask AI 個性"):
    """編輯 /ask（Gemini）的 system_instruction。輸入框會預先填入目前的內容；留空送出＝恢復預設。"""

    def __init__(self, current: str, max_len: int):
        super().__init__()
        # 輸入框在這裡建立，才能把「目前的個性」當成預設值填進去
        self.persona = discord.ui.TextInput(
            label="system_instruction（留空＝恢復預設）",
            style=discord.TextStyle.paragraph,
            placeholder="例如：你是一隻愛吃魚的貓娘，說話句尾要加「喵」。",
            default=current[:max_len],
            required=False,
            max_length=max_len,
        )
        self.add_item(self.persona)

    async def on_submit(self, interaction: discord.Interaction):
        ai = interaction.client.get_cog("AI")
        if ai is None:
            return await interaction.response.send_message(
                "❌ AI 模組尚未載入（.env 沒設定 GEMINI_API_KEY 或 GROQ_API_KEY，或載入失敗）。", ephemeral=True
            )
        text = self.persona.value.strip()
        await ai.set_system(text)
        if text:
            print(f"[後台] {interaction.user}（{interaction.user.id}）修改 /ask 個性（{len(text)} 字）")
            preview = text if len(text) <= 300 else text[:299] + "…"
            msg = f"✅ 已更新 /ask 的 AI 個性（{len(text)} 字），下一次 /ask 起生效。\n>>> {preview}"
        else:
            print(f"[後台] {interaction.user}（{interaction.user.id}）將 /ask 個性恢復預設")
            msg = "✅ 已恢復成預設的 AI 個性，下一次 /ask 起生效。"
        await interaction.response.send_message(
            msg, ephemeral=True, allowed_mentions=discord.AllowedMentions.none()
        )


class AddAutoReplyModal(AdminModal, title="🤖 新增自動回覆"):
    trigger_input = discord.ui.TextInput(
        label="觸發文字（訊息包含它就會回覆）",
        placeholder="例如：你好",
        max_length=100,
    )
    reply_input = discord.ui.TextInput(
        label="機器人要回覆的內容",
        style=discord.TextStyle.paragraph,
        placeholder="例如：你好呀！有什麼我可以幫忙的嗎？",
        max_length=1800,
    )

    async def on_submit(self, interaction: discord.Interaction):
        trigger = self.trigger_input.value.strip()
        response = self.reply_input.value.strip()
        if not trigger or not response:
            return await interaction.response.send_message("❌ 觸發文字和回覆內容都不能是空白。", ephemeral=True)

        cog: AutoReply = interaction.client.get_cog("AutoReply")
        if cog is None:
            return await interaction.response.send_message("❌ 自動回覆模組尚未載入。", ephemeral=True)

        rule_id = await cog.add_rule(trigger, response, interaction.user.id)
        if rule_id is None:
            return await interaction.response.send_message(
                f"❌ 已經有相同的觸發文字「{trigger}」了，請先到「自動回覆列表」刪除舊的再新增。", ephemeral=True
            )
        print(f"[後台] {interaction.user}（{interaction.user.id}）新增自動回覆 #{rule_id}：{trigger!r}")
        await interaction.response.send_message(
            f"✅ 已新增自動回覆 `#{rule_id}`\n"
            f"只要有人的訊息包含 **{discord.utils.escape_markdown(trigger)}**，我就會回覆：\n"
            f">>> {response}",
            ephemeral=True,
            allowed_mentions=discord.AllowedMentions.none(),
        )


def short(text: str, limit: int) -> str:
    """換行壓成空白、截斷、並跳脫 Markdown，給列表預覽用。"""
    text = " ".join(text.split())
    if len(text) > limit:
        text = text[: limit - 1] + "…"
    return discord.utils.escape_markdown(text)


class DeleteAutoReplySelect(discord.ui.Select):
    def __init__(self, rules: list[tuple[int, str, str]]):
        options = [
            discord.SelectOption(
                label=trigger[:100],
                description=" ".join(response.split())[:100] or "（空白）",
                value=str(rule_id),
            )
            for rule_id, trigger, response in rules[:AUTO_REPLY_LIST_MAX]
        ]
        super().__init__(placeholder="🗑️ 選擇要刪除的自動回覆", options=options, row=0)

    async def callback(self, interaction: discord.Interaction):
        view: AutoReplyListView = self.view
        rule_id = int(self.values[0])
        deleted = await view.auto.delete_rule(rule_id)
        if deleted:
            print(f"[後台] {interaction.user}（{interaction.user.id}）刪除自動回覆 #{rule_id}")
        # 不管刪成功與否都重新整理列表（可能別的管理員已經刪掉了）
        new_view = AutoReplyListView(view.cog, view.auto, await view.auto.list_rules())
        new_view.source = view.source
        view.stop()
        await interaction.response.edit_message(embed=new_view.build_embed(), view=new_view)


class AutoReplyListView(AdminView):
    """自動回覆列表：下拉選單刪除、按鈕返回總覽。"""

    def __init__(self, cog: "Backend", auto: "AutoReply", rules: list[tuple[int, str, str]]):
        super().__init__()
        self.cog = cog
        self.auto = auto
        self.rules = rules
        if rules:
            self.add_item(DeleteAutoReplySelect(rules))

    def build_embed(self) -> discord.Embed:
        lines = [
            f"`#{rid}` **{short(trigger, 30)}** → {short(response, 60)}"
            for rid, trigger, response in self.rules[:AUTO_REPLY_LIST_MAX]
        ]
        embed = discord.Embed(
            title="🤖 自動回覆列表",
            description="\n".join(lines) or "目前沒有任何自動回覆。\n回到總覽按「新增自動回覆」來建立第一條吧！",
            color=discord.Color.teal(),
        )
        footer = f"共 {len(self.rules)} 筆 · 訊息包含觸發文字（不分大小寫）就會自動回覆"
        if len(self.rules) > AUTO_REPLY_LIST_MAX:
            footer += f" · 只顯示前 {AUTO_REPLY_LIST_MAX} 筆"
        embed.set_footer(text=footer)
        return embed

    @discord.ui.button(label="返回總覽", emoji="⬅️", style=discord.ButtonStyle.secondary, row=1)
    async def back(self, interaction: discord.Interaction, button: discord.ui.Button):
        panel = BackendPanel(self.cog)
        panel.source = self.source
        self.stop()
        await interaction.response.edit_message(embed=await self.cog.overview_embed(), view=panel)


# ───────────────────────── 後台面板 ─────────────────────────
def fmt_uptime(seconds: float) -> str:
    d, rem = divmod(int(seconds), 86400)
    h, rem = divmod(rem, 3600)
    m, s = divmod(rem, 60)
    return f"{d} 天 {h} 小時 {m} 分 {s} 秒" if d else f"{h} 小時 {m} 分 {s} 秒"


class BackendPanel(AdminView):
    def __init__(self, cog: "Backend"):
        super().__init__()
        self.cog = cog

    # ── 第 1 排：查看 ──
    @discord.ui.button(label="總覽", emoji="📊", style=discord.ButtonStyle.primary, row=0)
    async def overview(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.edit_message(embed=await self.cog.overview_embed(), view=self)

    @discord.ui.button(label="伺服器", emoji="🌐", style=discord.ButtonStyle.secondary, row=0)
    async def guilds(self, interaction: discord.Interaction, button: discord.ui.Button):
        guilds = sorted(self.cog.bot.guilds, key=lambda g: g.member_count or 0, reverse=True)
        lines = [f"**{g.name}** — {g.member_count} 人\n`{g.id}`" for g in guilds[:15]]
        embed = discord.Embed(
            title="🌐 伺服器列表", description="\n".join(lines) or "（沒有加入任何伺服器）", color=discord.Color.green()
        )
        embed.set_footer(text=f"共 {len(guilds)} 個伺服器" + ("，只顯示人數最多的 15 個" if len(guilds) > 15 else ""))
        await interaction.response.edit_message(embed=embed, view=self)

    @discord.ui.button(label="提醒", emoji="⏰", style=discord.ButtonStyle.secondary, row=0)
    async def reminders(self, interaction: discord.Interaction, button: discord.ui.Button):
        db = self.cog.bot.db
        try:
            async with db.execute("SELECT COUNT(*) FROM reminders") as cur:
                total = (await cur.fetchone())[0]
            async with db.execute(
                "SELECT id, user_id, remind_at, message FROM reminders ORDER BY remind_at LIMIT 15"
            ) as cur:
                rows = await cur.fetchall()
        except Exception:  # noqa: BLE001  （extras 尚未建表時）
            total, rows = 0, []
        lines = [f"`#{rid}` <@{uid}> <t:{int(ts)}:R> — {msg[:50]}" for rid, uid, ts, msg in rows]
        embed = discord.Embed(
            title="⏰ 待處理的提醒", description="\n".join(lines) or "目前沒有任何提醒。", color=discord.Color.blurple()
        )
        embed.set_footer(text=f"共 {total} 筆" + ("，只顯示最近 15 筆" if total > 15 else ""))
        await interaction.response.edit_message(embed=embed, view=self)

    # ── 第 2 排：操作 ──
    @discord.ui.button(label="發送公告", emoji="📢", style=discord.ButtonStyle.success, row=1)
    async def announce(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_modal(AnnounceModal())

    @discord.ui.button(label="機器人狀態", emoji="🎭", style=discord.ButtonStyle.success, row=1)
    async def status(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_modal(StatusModal())

    @discord.ui.button(label="資料清理", emoji="🗑️", style=discord.ButtonStyle.secondary, row=1)
    async def cleanup(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_modal(CleanupModal())

    # ── 第 3 排：自動回覆 ──
    @discord.ui.button(label="新增自動回覆", emoji="🤖", style=discord.ButtonStyle.success, row=2)
    async def add_auto_reply(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_modal(AddAutoReplyModal())

    @discord.ui.button(label="自動回覆列表", emoji="📋", style=discord.ButtonStyle.secondary, row=2)
    async def list_auto_reply(self, interaction: discord.Interaction, button: discord.ui.Button):
        auto: AutoReply = self.cog.bot.get_cog("AutoReply")
        if auto is None:
            return await reply(interaction, "❌ 自動回覆模組尚未載入。")
        view = AutoReplyListView(self.cog, auto, await auto.list_rules())
        view.source = self.source
        self.stop()
        await interaction.response.edit_message(embed=view.build_embed(), view=view)

    # ── 第 4 排：系統 ──
    @discord.ui.button(label="重新載入擴充", emoji="🔄", style=discord.ButtonStyle.secondary, row=3)
    async def reload(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.defer(ephemeral=True, thinking=True)
        try:
            await self.cog.bot.reload_extension("extras")
        except Exception as e:  # noqa: BLE001
            traceback.print_exception(type(e), e, e.__traceback__)
            return await interaction.followup.send(f"❌ 重新載入失敗（已保留舊版）：`{e!r}`"[:1900], ephemeral=True)
        print(f"[後台] {interaction.user}（{interaction.user.id}）重新載入 extras")
        await interaction.followup.send("✅ 已重新載入 extras.py。若有改動指令參數，請再按「同步指令」。", ephemeral=True)

    @discord.ui.button(label="同步指令", emoji="🌳", style=discord.ButtonStyle.secondary, row=3)
    async def sync(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.defer(ephemeral=True, thinking=True)
        try:
            synced = await self.cog.bot.tree.sync()
        except discord.HTTPException as e:
            return await interaction.followup.send(f"❌ 同步失敗：`{e}`"[:1900], ephemeral=True)
        print(f"[後台] {interaction.user}（{interaction.user.id}）同步指令（{len(synced)} 個）")
        await interaction.followup.send(f"✅ 已同步 {len(synced)} 個全域指令。", ephemeral=True)

    @discord.ui.button(label="關閉機器人", emoji="🛑", style=discord.ButtonStyle.danger, row=3)
    async def shutdown(self, interaction: discord.Interaction, button: discord.ui.Button):
        admin = interaction.user

        async def do_shutdown() -> str:
            print(f"[後台] {admin}（{admin.id}）要求關閉機器人")
            self.cog.shutdown_task = asyncio.create_task(self.cog.close_later())
            return "🛑 機器人即將關閉。（若主機設定了自動重啟，它會再次上線）"

        view = ConfirmView(do_shutdown)
        view.source = interaction
        await interaction.response.send_message("⚠️ 確定要關閉機器人嗎？", view=view, ephemeral=True)

    # ── 第 5 排：C幣 ──
    @discord.ui.button(label="發放 C幣", emoji=COIN_EMOJI, style=discord.ButtonStyle.success, row=4)
    async def give_coin(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_modal(GiveCoinModal())

    # ── 第 5 排：AI ──
    @discord.ui.button(label="AI 個性", emoji="🧠", style=discord.ButtonStyle.success, row=4)
    async def ai_persona(self, interaction: discord.Interaction, button: discord.ui.Button):
        ai = self.cog.bot.get_cog("AI")
        if ai is None:
            return await reply(interaction, "❌ AI 模組尚未載入（.env 沒設定 GEMINI_API_KEY 或 GROQ_API_KEY，或載入失敗）。")
        await interaction.response.send_modal(AIPersonaModal(ai.system, ai.SYSTEM_MAX_LEN))


# ───────────────────────── Cog ─────────────────────────
class Backend(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.started = time.time()
        self.shutdown_task: asyncio.Task | None = None

    async def close_later(self):
        await asyncio.sleep(1)
        await self.bot.close()

    async def overview_embed(self) -> discord.Embed:
        bot = self.bot

        async def count(table: str) -> str:
            try:
                async with bot.db.execute(f"SELECT COUNT(*) FROM {table}") as cur:
                    return str((await cur.fetchone())[0])
            except Exception:  # noqa: BLE001
                return "—"

        try:
            db_size = f"{os.path.getsize(DB_PATH) / 1024:.1f} KB"
        except OSError:
            db_size = "未知"

        embed = discord.Embed(title="🛠️ 管理後台", color=discord.Color.blurple(), timestamp=discord.utils.utcnow())
        embed.add_field(name="延遲", value=f"{round(bot.latency * 1000)} ms")
        embed.add_field(name="運作時間", value=fmt_uptime(time.time() - self.started))
        embed.add_field(name="指令數", value=len(bot.tree.get_commands()))
        embed.add_field(name="伺服器數", value=len(bot.guilds))
        embed.add_field(name="成員總數", value=sum(g.member_count or 0 for g in bot.guilds))
        embed.add_field(name="版本", value=f"Python {platform.python_version()}\ndiscord.py {discord.__version__}")
        embed.add_field(
            name=f"資料庫（{db_size}）",
            value=(
                f"等級 {await count('levels')} 筆　警告 {await count('warnings')} 筆\n"
                f"提醒 {await count('reminders')} 筆　客服設定 {await count('ticket_settings')} 筆\n"
                f"自動回覆 {await count('auto_replies')} 筆　C幣帳戶 {await count('coins')} 筆"
            ),
            inline=False,
        )
        embed.set_footer(text="按下方按鈕操作 · 閒置 5 分鐘後自動停用")
        return embed

    @app_commands.command(name="backend", description="開啟管理後台（僅限管理員名單）")
    async def backend(self, interaction: discord.Interaction):
        if not await check_admin(interaction):
            return
        print(f"[後台] {interaction.user}（{interaction.user.id}）開啟了管理後台")
        view = BackendPanel(self)
        view.source = interaction
        await interaction.response.send_message(embed=await self.overview_embed(), view=view, ephemeral=True)


# ───────────────────────── 自動回覆 Cog ─────────────────────────
class AutoReply(commands.Cog):
    """訊息包含管理員設定的觸發文字時，自動回覆預先設定好的內容。"""

    def __init__(self, bot):
        self.bot = bot
        # (id, 觸發文字, 回覆內容)；觸發文字長的排前面，同時符合多條時優先用最具體的那條
        self.rules: list[tuple[int, str, str]] = []
        self._last: dict[tuple[int, int], float] = {}  # (使用者, 規則) → 上次觸發時間
        self._last_channel: dict[int, float] = {}      # 頻道 → 上次自動回覆時間

    async def cog_load(self):
        await self.bot.db.execute(
            "CREATE TABLE IF NOT EXISTS auto_replies ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, trigger TEXT NOT NULL, "
            "response TEXT NOT NULL, created_by INTEGER, created_at REAL)"
        )
        await self.bot.db.commit()
        await self.refresh()

    async def refresh(self):
        async with self.bot.db.execute("SELECT id, trigger, response FROM auto_replies") as cur:
            rows = await cur.fetchall()
        self.rules = sorted(rows, key=lambda r: len(r[1]), reverse=True)

    async def list_rules(self) -> list[tuple[int, str, str]]:
        return sorted(self.rules, key=lambda r: r[0])

    async def add_rule(self, trigger: str, response: str, admin_id: int) -> int | None:
        """新增規則，回傳規則 ID；觸發文字（不分大小寫）重複時回傳 None。"""
        folded = trigger.casefold()
        if any(t.casefold() == folded for _, t, _ in self.rules):
            return None
        async with self.bot.db.execute(
            "INSERT INTO auto_replies (trigger, response, created_by, created_at) VALUES (?, ?, ?, ?)",
            (trigger, response, admin_id, time.time()),
        ) as cur:
            rule_id = cur.lastrowid
        await self.bot.db.commit()
        await self.refresh()
        return rule_id

    async def delete_rule(self, rule_id: int) -> bool:
        async with self.bot.db.execute("DELETE FROM auto_replies WHERE id = ?", (rule_id,)) as cur:
            deleted = cur.rowcount > 0
        await self.bot.db.commit()
        await self.refresh()
        return deleted

    @commands.Cog.listener()
    async def on_message(self, message: discord.Message):
        if message.author.bot or not message.content or not self.rules:
            return
        text = message.content.casefold()
        for rule_id, trigger, response in self.rules:
            if trigger.casefold() not in text:
                continue
            key = (message.author.id, rule_id)
            now = time.time()
            if now - self._last.get(key, 0) < AUTO_REPLY_COOLDOWN:
                return
            if now - self._last_channel.get(message.channel.id, 0) < AUTO_REPLY_CHANNEL_COOLDOWN:
                return
            # 沒有「發言」或「讀取歷史訊息」權限就不要送出：送了只會被 403 擋下，
            # 而 403 會累積進 Discord 的「無效請求」額度，太多會讓整個 IP 被暫時封鎖。
            if message.guild is not None:
                perms = message.channel.permissions_for(message.guild.me)
                if not (perms.send_messages and perms.read_message_history):
                    return
            self._last[key] = now
            self._last_channel[message.channel.id] = now
            try:
                await message.reply(response)  # 用「回覆」的方式，會標記對方
            except (discord.HTTPException, discord.RateLimited):
                pass  # 訊息已被刪除、被限速等，就略過
            return  # 一則訊息最多回覆一次（只用最具體的那條規則）


async def setup(bot):
    if not ADMIN_IDS:
        print("⚠️ admin.py 的 ADMIN_IDS 是空的，目前沒有人能開啟 /backend 管理後台。")
    await bot.add_cog(Backend(bot))
    await bot.add_cog(AutoReply(bot))
