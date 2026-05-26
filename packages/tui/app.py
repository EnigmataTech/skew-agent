"""rfb2-agent — Textual Terminal UI

Connects to the rfb2-agent API server.
Set RFB2_API_URL in .env (default: http://localhost:3200).

Run: python packages/tui/app.py
"""

import asyncio
import logging
import os
import sys
from datetime import datetime
from typing import Any, Optional

from dotenv import load_dotenv
from rich.markup import escape as rich_escape
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.screen import ModalScreen
from textual.timer import Timer
from textual.widgets import (
    Button,
    DataTable,
    Footer,
    Header,
    Input,
    Label,
    RichLog,
    Rule,
    Select,
    Static,
    TabbedContent,
    TabPane,
)
from textual import work

from api_client import (  # noqa: E402  (local module, run from packages/tui/)
    get_dashboard,
    get_mispricings,
    get_trades,
    get_calibration,
    get_log,
    get_summary,
    post_tick,
    post_backtest,
)

load_dotenv()

API_BASE = os.getenv("RFB2_API_URL", "http://localhost:3200").rstrip("/")

# ─── Helpers ─────────────────────────────────────────────────────────────

def fmt_pct(v: float | None, digits: int = 1) -> str:
    if v is None:
        return "—"
    return f"{v * 100:.{digits}f}%"

def fmt_dollars(v: float | None) -> str:
    if v is None:
        return "—"
    sign = "+" if v >= 0 else ""
    return f"{sign}${v:,.2f}"

def fmt_edge(v: float | None) -> str:
    if v is None:
        return "—"
    sign = "+" if v >= 0 else ""
    return f"{sign}{v * 100:.1f}pp"

def fmt_duration(seconds: int) -> str:
    if seconds < 3600:
        return f"{seconds // 60}m"
    if seconds < 86400:
        return f"{seconds // 3600}h"
    return f"{seconds // 86400}d"

def color_for_edge(edge: float) -> str:
    if edge > 0.01:
        return "bold green"
    if edge < -0.01:
        return "bold red"
    return "bold yellow"

def color_for_pnl(pnl: float | None) -> str:
    if pnl is None:
        return "dim"
    if pnl > 0:
        return "bold green"
    if pnl < 0:
        return "bold red"
    return "dim"


# ─── Trade Detail Modal ─────────────────────────────────────────────────

class TradeDetailModal(ModalScreen):
    BINDINGS = [("escape", "dismiss", "Dismiss"), ("enter", "dismiss", "Dismiss")]

    def __init__(self, trade: dict) -> None:
        super().__init__()
        self._trade = trade

    def compose(self) -> ComposeResult:
        t = self._trade
        pnl = t.get("pnl_usdc") or t.get("unrealized_pnl")
        is_open = t.get("status", "").lower() == "open"

        rows = [
            ("Trade ID",       str(t.get("trade_id", "—"))),
            ("Market ID",      str(t.get("market_id", "—"))),
            ("Venue",          t.get("venue", "—")),
            ("Question",       (t.get("question", "—") or "—")[:60]),
            ("Asset",          t.get("asset", "—")),
            ("Side",           t.get("side", "—")),
            ("Settlement",     t.get("settlement", "—")),
            ("Op",             t.get("op", "—")),
            ("Strike",         f"${t.get('strike', 0):,.0f}"),
            ("Expiry",         datetime.fromtimestamp(t.get("expiry_unix", 0)).strftime("%Y-%m-%d %H:%M") if t.get("expiry_unix") else "—"),
            ("Entry Market P", fmt_pct(t.get("entry_market_p"))),
            ("Entry Model P",  fmt_pct(t.get("entry_model_p"))),
            ("Entry Edge",     fmt_edge(t.get("entry_edge"))),
            ("Size",           f"${t.get('size_usdc', 0):.2f}"),
            ("Status",         t.get("status", "—")),
            ("P&L",            fmt_dollars(pnl)),
        ]

        mid = len(rows) // 2
        col_a = rows[:mid]
        col_b = rows[mid:]

        with Vertical(id="modal-container"):
            yield Static("── TRADE DETAIL ──", id="modal-title")
            yield Rule()
            with Horizontal(id="modal-grid"):
                with Vertical(id="modal-col-a"):
                    for label, value in col_a:
                        with Horizontal(classes="detail-row"):
                            yield Static(f"{label}:", classes="detail-label")
                            yield Static(value, classes="detail-value")
                with Vertical(id="modal-col-b"):
                    for label, value in col_b:
                        with Horizontal(classes="detail-row"):
                            yield Static(f"{label}:", classes="detail-label")
                            yield Static(value, classes="detail-value")
            yield Rule()
            yield Button("Dismiss", id="modal-dismiss", variant="default")

    async def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "modal-dismiss":
            self.dismiss()


# ─── Main Application ───────────────────────────────────────────────────

class RFB2TradingApp(App):
    """rfb2-agent — Prediction Market Mispricing Terminal"""

    CSS = """
    Screen { background: $surface; }

    .panel {
        border: solid $primary;
        padding: 0 1;
        margin: 0 1 1 0;
    }

    /* Top bar */
    #top-bar         { height: 5; }
    #market-panel    { width: 36; }
    #status-panel    { width: 1fr; }
    #pnl-panel       { width: 26; }

    /* Dashboard split */
    #main-split { height: 1fr; }
    #left-col   { width: 1fr; }
    #right-col  { width: 1fr; }

    /* Tables */
    #mispricings-table { height: 1fr; }
    #trades-table      { height: 1fr; min-height: 8; }
    #agent-log         { height: 1fr; min-height: 5; }
    #activity-log      { height: 8; min-height: 4; }

    /* Calibration tab */
    #calibration-table { height: 1fr; }
    #calibration-info  { height: 3; padding: 0 1; }

    /* Settings tab */
    #settings-form { padding: 1 2; overflow-y: auto; }
    .section-header {
        color: $accent;
        text-style: bold;
        height: 1;
        margin-bottom: 1;
    }
    .form-row          { height: 3; margin-bottom: 1; align: left middle; }
    .form-label        { width: 24; content-align: right middle; padding-right: 2; }
    .btn-row           { height: 5; margin: 1 0; align: center middle; }
    .action-btn        { min-width: 30; margin: 0 1; }

    /* Modal */
    #modal-container {
        background: $surface;
        border: thick $primary;
        padding: 1 2;
        width: 90;
        height: auto;
        margin: 2 5;
    }
    #modal-title   { text-align: center; color: $accent; text-style: bold; margin-bottom: 1; }
    #modal-grid    { height: auto; }
    #modal-col-a   { width: 1fr; }
    #modal-col-b   { width: 1fr; }
    .detail-row    { height: 1; }
    .detail-label  { width: 18; color: $text-muted; content-align: right middle; padding-right: 1; }
    .detail-value  { width: 1fr; }
    #modal-buttons { height: 3; margin-top: 1; align: center middle; }

    /* Calibration sparklines */
    #calib-sparkline-panel { height: 8; margin: 0 1 1 0; }
    .sparkline-row    { height: 3; }
    .sparkline-label  { width: 10; color: $text-muted; }
    .sparkline-widget { width: 1fr; height: 3; }
    #banner-box { height: 3; padding: 0 1; margin: 0 1 1 0; }
    """

    BINDINGS = [
        Binding("1", "switch_tab('tab-dashboard')", "Dashboard"),
        Binding("2", "switch_tab('tab-calibration')", "Calibration"),
        Binding("3", "switch_tab('tab-settings')", "Settings"),
        Binding("r", "refresh_all", "Refresh"),
        Binding("t", "run_tick", "Tick"),
        Binding("b", "run_backtest", "Backtest"),
        Binding("ctrl+l", "clear_log", "Clear Log"),
        Binding("q", "quit", "Quit"),
    ]

    def __init__(self) -> None:
        super().__init__()
        self._auto_refresh: bool = True
        self._timer_dash: Optional[Timer] = None
        self._timer_log: Optional[Timer] = None
        self._connected: bool = False
        self._trades_row_keys: dict[str, Any] = {}
        self._misp_row_keys: dict[str, Any] = {}
        self._tick_running: bool = False
        self._backtest_running: bool = False

    # ─── Layout ──────────────────────────────────────────────────────────

    def compose(self) -> ComposeResult:
        yield Header(show_clock=True)
        with TabbedContent(id="tabs"):

            # ── Dashboard ────────────────────────────────────────────────
            with TabPane("Dashboard  [1]", id="tab-dashboard"):
                with Horizontal(id="top-bar"):
                    yield Static("Connecting...", id="market-panel", classes="panel")
                    yield Static("",              id="status-panel", classes="panel")
                    yield Static("",              id="pnl-panel",    classes="panel")
                with Horizontal(id="main-split"):
                    with Vertical(id="left-col"):
                        yield DataTable(id="mispricings-table", classes="panel", cursor_type="row")
                        yield RichLog(id="agent-log", markup=True, classes="panel")
                    with Vertical(id="right-col"):
                        yield DataTable(id="trades-table", classes="panel", cursor_type="row")
                        yield RichLog(id="activity-log", classes="panel", markup=True)

            # ── Calibration ──────────────────────────────────────────────
            with TabPane("Calibration  [2]", id="tab-calibration"):
                with Horizontal(id="banner-box"):
                    yield Static("Run backtest to generate calibration data", id="calibration-info")
                yield DataTable(id="calibration-table", classes="panel", cursor_type="row")
                with Horizontal(classes="btn-row"):
                    yield Button("▶  Run Backtest", id="btn-backtest", variant="primary", classes="action-btn")

            # ── Settings ─────────────────────────────────────────────────
            with TabPane("Settings  [3]", id="tab-settings"):
                with Vertical(id="settings-form"):
                    yield Static("▸ Connection", classes="section-header")
                    with Horizontal(classes="form-row"):
                        yield Label("API Server", classes="form-label")
                        yield Static(API_BASE, id="setting-api-url")
                    yield Rule()
                    yield Static("▸ Actions", classes="section-header")
                    with Horizontal(classes="btn-row"):
                        yield Button("▶  Run Paper Tick", id="btn-tick", variant="primary", classes="action-btn")
                        yield Button("▶  Run Backtest (full)", id="btn-backtest-settings", variant="default", classes="action-btn")
                    with Horizontal(classes="btn-row"):
                        yield Button("⟳  Refresh All", id="btn-refresh", variant="default", classes="action-btn")
                    yield Rule()
                    yield Static("▸ About", classes="section-header")
                    yield Static("rfb2-agent v0.0.1 — Prediction Market Mispricing Agent")
                    yield Static("Polymarket + Kalshi • BTC/ETH • Log-Normal Pricing")
                    yield Static(f"API: {API_BASE}")

        yield Footer()

    # ─── Lifecycle ───────────────────────────────────────────────────────

    def on_mount(self) -> None:
        mt = self.query_one("#mispricings-table", DataTable)
        mt.add_columns("Edge", "Asset", "Venue", "Op", "Strike", "Expiry", "Model P", "Market P", "Liq")
        mt.border_title = "Mispricings  (sorted by |edge|)"

        ot = self.query_one("#trades-table", DataTable)
        ot.add_columns("ID", "Asset", "Side", "Strike", "Edge", "Move", "Unreal P&L")
        ot.border_title = "Paper Trades"

        ct = self.query_one("#calibration-table", DataTable)
        ct.add_columns("Asset", "Kind", "Bucket", "N", "Avg Pred", "Actual Rate", "Reliability")
        ct.border_title = "Calibration  (reliability per bucket)"

        self.query_one("#agent-log", RichLog).border_title = "Agent Log"
        self.query_one("#activity-log", RichLog).border_title = "Activity"
        self.query_one("#market-panel", Static).border_title = "Markets"
        self.query_one("#status-panel", Static).border_title = "Status"
        self.query_one("#pnl-panel", Static).border_title = "Paper P&L"

        self.call_after_refresh(self._initialize_app)

    def _log(self, msg: str, style: str = "") -> None:
        ts = datetime.now().strftime("%H:%M:%S")
        if style:
            self.query_one("#activity-log", RichLog).write(f"[dim]{ts}[/dim] [{style}]{rich_escape(msg)}[/{style}]")
        else:
            self.query_one("#activity-log", RichLog).write(f"[dim]{ts}[/dim] {rich_escape(msg)}")

    def _set_status(self, connected: bool, text: str = "") -> None:
        self._connected = connected
        sp = self.query_one("#status-panel", Static)
        if connected:
            sp.update(f"[green]● Connected[/green]\n{text}")
        else:
            sp.update(f"[red]● Disconnected[/red]\n{text}")

    @work(exclusive=True)
    async def _initialize_app(self) -> None:
        self._log(f"Connecting to {API_BASE}...")
        try:
            from api_client import get_health
            health = await get_health()
            if health.get("status") == "healthy":
                self._log("Server connected", style="green")
                self._set_status(connected=True, text=f"Healthy @ {datetime.fromtimestamp(health.get('ts', 0)).strftime('%H:%M:%S')}")
            else:
                self._log(f"Server unhealthy: {health}", style="red")
                self._set_status(connected=False, text="Unhealthy")
                return
        except Exception as e:
            self._log(f"Cannot reach server: {e}", style="red")
            self._set_status(connected=False, text=str(e)[:40])
            return

        await self._refresh_all_data()

        self._timer_dash = self.set_interval(10, self._refresh_dashboard)
        self._timer_log = self.set_interval(5, self._refresh_log)

    # ─── Data Refresh ────────────────────────────────────────────────────

    async def _refresh_dashboard(self) -> None:
        if not self._connected:
            return
        try:
            dash = await get_dashboard()
            self._update_market_panel(dash)
            self._update_status_panel(dash)
            self._update_pnl_panel(dash)
            self._update_mispricings_table(dash)
            self._update_trades_table(dash)
        except Exception as e:
            self._log(f"Refresh error: {e}", style="red")

    async def _refresh_log(self) -> None:
        if not self._connected:
            return
        try:
            log_data = await get_log(n=100)
            lines = log_data.get("lines", [])
            if lines:
                log_widget = self.query_one("#agent-log", RichLog)
                log_widget.clear()
                for line in lines[-50:]:
                    log_widget.write(rich_escape(line))
        except Exception:
            pass

    async def _refresh_all_data(self) -> None:
        await self._refresh_dashboard()
        await self._refresh_log()

    # ─── Widget Updates ──────────────────────────────────────────────────

    def _update_market_panel(self, dash: dict) -> None:
        spot = dash.get("spot", {})
        vol = dash.get("vol", {})
        btc_s = spot.get("BTC")
        eth_s = spot.get("ETH")
        btc_v = vol.get("BTC")
        eth_v = vol.get("ETH")
        text = (
            f"[bold]BTC[/bold] ${btc_s:,.2f}\n" if btc_s else "[bold]BTC[/bold] —\n"
        ) + (
            f"[bold]ETH[/bold] ${eth_s:,.2f}\n" if eth_s else "[bold]ETH[/bold] —\n"
        ) + (
            f"σ_BTC: {fmt_pct(btc_v)}\n" if btc_v else "σ_BTC: —\n"
        ) + (
            f"σ_ETH: {fmt_pct(eth_v)}" if eth_v else "σ_ETH: —"
        )
        self.query_one("#market-panel", Static).update(text)

    def _update_status_panel(self, dash: dict) -> None:
        summary = dash.get("summary", {})
        open_ = summary.get("open", {})
        settled = summary.get("settled", {})
        n_open = open_.get("n", 0) if isinstance(open_, dict) else 0
        n_settled = settled.get("n", 0) if isinstance(settled, dict) else 0
        pnl = settled.get("pnl") if isinstance(settled, dict) else None
        text = (
            f"[bold]Open:[/bold] {n_open}\n"
            f"[bold]Settled:[/bold] {n_settled}\n"
            f"[bold]P&L:[/bold] {fmt_dollars(pnl)}"
        )
        self.query_one("#status-panel", Static).update(text)

    def _update_pnl_panel(self, dash: dict) -> None:
        summary = dash.get("summary", {})
        settled = summary.get("settled", {})
        open_ = summary.get("open", {})
        unrealized = summary.get("unrealized", {})
        if isinstance(settled, dict):
            realized = settled.get("pnl") or 0
            unreal = unrealized.get("pnl") or 0 if isinstance(unrealized, dict) else 0
            total = realized + unreal
            wins = settled.get("wins")
            notional = open_.get("notional", 0) if isinstance(open_, dict) else 0
            total_color = color_for_pnl(total)
            unreal_color = color_for_pnl(unreal)
            text = (
                f"Realized:   [{color_for_pnl(realized)}]{fmt_dollars(realized)}[/]\n"
                f"Unrealized: [{unreal_color}]{fmt_dollars(unreal)}[/]\n"
                f"Total:      [{total_color}]{fmt_dollars(total)}[/]\n"
                f"Wins: {wins or 0}  Exposure: ${notional:,.0f}"
            )
            self.query_one("#pnl-panel", Static).update(text)

    def _update_mispricings_table(self, dash: dict) -> None:
        mt = self.query_one("#mispricings-table", DataTable)
        mt.clear()
        misps = dash.get("mispricings", [])
        for m in misps[:50]:
            edge = m.get("edge", 0)
            tag = color_for_edge(edge)
            strike = m.get("strike", 0)
            strike_str = f"${strike:,.0f}" if m.get("strike_upper") is None else f"${strike:,.0f}-${m['strike_upper']:,.0f}"
            expiry = datetime.fromtimestamp(m.get("expiry_unix", 0)).strftime("%m/%d") if m.get("expiry_unix") else "—"
            mt.add_row(
                f"[{tag}]{fmt_edge(edge)}[/]",
                m.get("asset", ""),
                m.get("venue", ""),
                m.get("op", ""),
                strike_str,
                expiry,
                fmt_pct(m.get("model_p")),
                fmt_pct(m.get("market_p")),
                fmt_dollars(m.get("liquidity")),
            )

    def _update_trades_table(self, dash: dict) -> None:
        ot = self.query_one("#trades-table", DataTable)
        ot.clear()
        trades = dash.get("openTrades", [])
        for t in trades[:30]:
            tid = str(t.get("trade_id", ""))[:12]
            side = t.get("side", "")
            # Prefer unrealized P&L for open positions, realized pnl_usdc for settled
            pnl = t.get("unrealized_pnl") if t.get("status") == "open" else t.get("pnl_usdc")
            entry_edge = t.get("entry_edge", 0)
            pnl_color = color_for_pnl(pnl)
            tag = color_for_edge(entry_edge)
            curr_p = t.get("curr_market_p")
            entry_p = t.get("entry_market_p", 0)
            move = f"{(curr_p - entry_p)*100:+.1f}pp" if curr_p is not None else "—"
            ot.add_row(
                tid,
                t.get("asset", ""),
                f"[bold]{side.upper()}[/bold]",
                f"${t.get('strike', 0):,.0f}",
                f"[{tag}]{fmt_edge(entry_edge)}[/]",
                move,
                f"[{pnl_color}]{fmt_dollars(pnl)}[/]",
            )

    # ─── Actions ─────────────────────────────────────────────────────────

    async def action_refresh_all(self) -> None:
        self._log("Refreshing all data...")
        self._timer_dash and self._timer_dash.reset()
        self._timer_log and self._timer_log.reset()
        if self._connected:
            await self._refresh_all_data()

    async def action_run_tick(self) -> None:
        if not self._connected:
            self._log("Not connected", style="red")
            return
        if self._tick_running:
            self._log("Tick already running", style="yellow")
            return
        self._tick_running = True
        self._log("Running tick cycle...", style="cyan")
        try:
            result = await post_tick()
            if "error" in result:
                self._log(f"Tick error: {result['error']}", style="red")
            else:
                summary = result.get("summary", {})
                settled = summary.get("settled", {})
                open_ = summary.get("open", {})
                pnl = settled.get("pnl") if isinstance(settled, dict) else 0
                n_open = open_.get("n", 0) if isinstance(open_, dict) else 0
                n_settled = settled.get("n", 0) if isinstance(settled, dict) else 0
                self._log(f"Tick complete: {n_open} open, {n_settled} settled, P&L=${pnl:.2f}", style="green")
            await self._refresh_all_data()
        except Exception as e:
            self._log(f"Tick error: {e}", style="red")
        finally:
            self._tick_running = False

    async def action_run_backtest(self) -> None:
        if not self._connected:
            self._log("Not connected", style="red")
            return
        if self._backtest_running:
            self._log("Backtest already running", style="yellow")
            return
        self._backtest_running = True
        self._log("Running full backtest (365d)...", style="cyan")
        try:
            result = await post_backtest()
            if "error" in result:
                self._log(f"Backtest error: {result['error']}", style="red")
            else:
                results = result.get("results", [])
                for r in results:
                    self._log(f"{r['asset']}: {r['historyDays']}d history", style="green")
                    for kind, stats in r.get("perKind", {}).items():
                        self._log(f"  {kind}: n={stats.get('n', 0)}, brier={stats.get('brier', 0):.4f}")
            await self._refresh_all_data()
            await self._refresh_calibration()
        except Exception as e:
            self._log(f"Backtest error: {e}", style="red")
        finally:
            self._backtest_running = False

    async def _refresh_calibration(self) -> None:
        try:
            cal = await get_calibration()
            ct = self.query_one("#calibration-table", DataTable)
            ct.clear()
            buckets = cal.get("buckets", [])
            if not buckets:
                self.query_one("#calibration-info", Static).update("[yellow]No calibration data yet — run a backtest first[/yellow]")
                return
            self.query_one("#calibration-info", Static).update(f"[green]{len(buckets)} calibration buckets loaded[/green]")
            for b in buckets:
                lo, hi = b.get("bucket_lo", 0), b.get("bucket_hi", 0)
                rate = b.get("actual_rate", 0) / 100  # already 0..1
                pred = b.get("avg_pred", 0)
                diff = rate - pred
                diff_str = f"{'+' if diff >= 0 else ''}{diff * 100:.1f}pp"
                diff_style = "green" if abs(diff) < 0.05 else ("yellow" if abs(diff) < 0.10 else "red")
                ct.add_row(
                    b.get("asset", ""),
                    b.get("kind", ""),
                    f"[{lo:.2f}, {hi:.2f})",
                    str(b.get("n", 0)),
                    fmt_pct(pred),
                    fmt_pct(rate),
                    f"[{diff_style}]{diff_str}[/]",
                )
        except Exception as e:
            self._log(f"Calibration refresh error: {e}", style="red")

    async def on_button_pressed(self, event: Button.Pressed) -> None:
        bid = event.button.id
        if bid in ("btn-tick",):
            await self.action_run_tick()
        elif bid in ("btn-backtest", "btn-backtest-settings"):
            await self.action_run_backtest()
        elif bid == "btn-refresh":
            await self.action_refresh_all()

    async def action_clear_log(self) -> None:
        self.query_one("#activity-log", RichLog).clear()

    async def action_switch_tab(self, tab: str) -> None:
        tc = self.query_one("#tabs", TabbedContent)
        tc.active = tab
        if tab == "tab-calibration":
            await self._refresh_calibration()

    def on_data_table_row_selected(self, event: DataTable.RowSelected) -> None:
        table_id = event.data_table.id
        if table_id == "trades-table":
            # Find the trade by index
            trades_data = self._get_trades_for_modal()
            row_key = event.row_key
            table = self.query_one("#trades-table", DataTable)
            try:
                rows = list(table.rows)
                idx = rows.index(row_key)
                if idx < len(trades_data):
                    self.push_screen(TradeDetailModal(trades_data[idx]))
            except (ValueError, IndexError):
                pass
        elif table_id == "mispricings-table":
            misp_data = self._get_misp_for_modal()
            row_key = event.row_key
            table = self.query_one("#mispricings-table", DataTable)
            try:
                rows = list(table.rows)
                idx = rows.index(row_key)
                if idx < len(misp_data):
                    self.push_screen(TradeDetailModal(misp_data[idx]))
            except (ValueError, IndexError):
                pass

    def _get_trades_for_modal(self) -> list:
        return []

    def _get_misp_for_modal(self) -> list:
        return []


# ─── Entry Point ────────────────────────────────────────────────────────

if __name__ == "__main__":
    app = RFB2TradingApp()
    app.run()
