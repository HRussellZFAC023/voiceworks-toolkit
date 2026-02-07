import wx
from threading import Thread
import logging
from config import Config
from settings_panel import SettingsPanel
from wx_log_handler import EVT_WX_LOG_EVENT, WxLogHandler
from pathlib import Path
import time

from file_drop_target import FileDropTarget
from scanner import Scanner
from scraper.cached_scraper import CachedScraper
from renamer import Renamer
from constants import COLORS

LOCALE_CHOICES = [
    ("English", "en_us"),
    ("Japanese", "ja_jp"),
    ("Chinese", "zh_cn"),
    ("Korean", "ko_kr"),
]


class ModernFrame(wx.Frame):
    def __init__(self, parent, config_path):
        super().__init__(parent, title="DLsite Renamer", size=(1200, 800))

        self.logger = logging.getLogger(__name__)
        self.config = Config(config_path)
        self._current_renamer = None

        # Setup UI first
        self.setup_ui()
        # Then setup logging after log_ctrl is created
        self.setup_logging()
        self.setup_events()
        self.Layout()
        self.Center()
        self.Bind(wx.EVT_CLOSE, self.on_close)

    def setup_ui(self):
        """Setup the main UI components"""
        self.SetBackgroundColour(COLORS["background"])
        main_sizer = wx.BoxSizer(wx.HORIZONTAL)

        # Left side panel (settings)
        left_panel = wx.Panel(self)
        left_sizer = wx.BoxSizer(wx.VERTICAL)

        # Settings sections in left panel
        self.settings_panel = SettingsPanel(left_panel, self.config)
        left_sizer.Add(self.settings_panel, 1, wx.EXPAND)
        left_panel.SetSizer(left_sizer)

        # Right side (log and status)
        right_panel = wx.Panel(self)
        right_sizer = wx.BoxSizer(wx.VERTICAL)

        # Tip text at the top
        tip_text = wx.StaticText(
            right_panel, label="Tip: Drag and drop folders here to process them"
        )
        tip_text.SetForegroundColour(COLORS["accent"])
        right_sizer.Add(tip_text, 0, wx.ALL, 5)

        # Log panel
        self.log_panel = self.create_log_panel(right_panel)
        right_sizer.Add(self.log_panel, 1, wx.EXPAND | wx.ALL, 5)

        # Bottom status bar with controls
        status_panel = wx.Panel(right_panel)
        status_sizer = wx.BoxSizer(wx.HORIZONTAL)

        self.browse_btn = wx.Button(status_panel, label="Browse")
        self.progress_gauge = wx.Gauge(status_panel, range=100, size=(200, -1))
        self.status_text = wx.StaticText(status_panel, label="Ready")
        self.counter_text = wx.StaticText(status_panel, label="")

        status_sizer.Add(self.browse_btn, 0, wx.ALIGN_CENTER_VERTICAL | wx.RIGHT, 10)
        status_sizer.Add(self.progress_gauge, 1, wx.ALIGN_CENTER_VERTICAL)
        status_sizer.Add(self.status_text, 0, wx.ALIGN_CENTER_VERTICAL | wx.LEFT, 10)
        status_sizer.Add(self.counter_text, 0, wx.ALIGN_CENTER_VERTICAL | wx.LEFT, 5)

        status_panel.SetSizer(status_sizer)
        right_sizer.Add(status_panel, 0, wx.EXPAND | wx.ALL, 5)

        right_panel.SetSizer(right_sizer)

        # Add panels to main sizer
        main_sizer.Add(left_panel, 0, wx.EXPAND | wx.ALL, 5)
        main_sizer.Add(right_panel, 1, wx.EXPAND | wx.ALL, 5)

        self.SetSizer(main_sizer)

    def create_log_panel(self, parent):
        """Create the log output panel."""
        panel = wx.Panel(parent)
        sizer = wx.BoxSizer(wx.VERTICAL)

        # Create log control with correct parent
        self.log_ctrl = wx.TextCtrl(
            panel,  # Note: parent is panel here
            style=wx.TE_MULTILINE | wx.TE_READONLY | wx.TE_RICH2 | wx.HSCROLL,
        )
        self.log_ctrl.SetBackgroundColour(COLORS["panel"])
        self.log_ctrl.SetFont(
            wx.Font(
                9, wx.FONTFAMILY_TELETYPE, wx.FONTSTYLE_NORMAL, wx.FONTWEIGHT_NORMAL
            )
        )

        sizer.Add(self.log_ctrl, 1, wx.EXPAND | wx.ALL, 5)
        panel.SetSizer(sizer)
        return panel

    def setup_events(self):
        # Enable drag and drop
        drop_target = FileDropTarget(self)
        self.log_ctrl.SetDropTarget(drop_target)
        self.browse_btn.Bind(wx.EVT_BUTTON, self.on_browse)

    def setup_logging(self):
        """Configure logging with multiple handlers."""
        # Create root logger
        root_logger = logging.getLogger()
        root_logger.setLevel(logging.INFO)

        # Clear any existing handlers
        root_logger.handlers.clear()

        # Create formatters
        detailed_formatter = logging.Formatter(
            "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
        )
        simple_formatter = logging.Formatter("%(asctime)s - %(message)s")

        # GUI handler
        gui_handler = WxLogHandler(self.log_ctrl)
        gui_handler.setLevel(logging.INFO)
        gui_handler.setFormatter(simple_formatter)
        root_logger.addHandler(gui_handler)

        # Terminal handler
        console_handler = logging.StreamHandler()
        console_handler.setLevel(logging.INFO)
        console_handler.setFormatter(detailed_formatter)
        root_logger.addHandler(console_handler)

        # File handler
        try:
            log_dir = Path("logs")
            log_dir.mkdir(exist_ok=True)

            # Create log file with timestamp
            timestamp = time.strftime("%Y%m%d-%H%M%S")
            log_file = log_dir / f"dlsite_renamer_{timestamp}.log"

            file_handler = logging.FileHandler(log_file, encoding="utf-8")
            file_handler.setLevel(logging.INFO)
            file_handler.setFormatter(detailed_formatter)
            root_logger.addHandler(file_handler)

            self.logger.info(f"Logging to file: {log_file}")
        except Exception as e:
            self.logger.error(f"Failed to setup file logging: {e}")

        # Bind the log event for GUI updates
        self.log_ctrl.Bind(EVT_WX_LOG_EVENT, self.on_log_event)

    def on_log_event(self, event):
        """Handle log events with color coding."""
        msg = event.message.strip("\r") + "\n"

        # Set color based on log level
        if event.levelno <= logging.INFO:
            color = COLORS["text"]
        elif event.levelno <= logging.WARNING:
            color = "#E9B44C"  # Warning color
        else:
            color = "#E35D6A"  # Error color

        # Append text with color
        self.log_ctrl.SetDefaultStyle(wx.TextAttr(color))
        self.log_ctrl.AppendText(msg)

        # Auto-scroll if near bottom
        if self.log_ctrl.GetScrollPos(wx.VERTICAL) >= (
            self.log_ctrl.GetScrollRange(wx.VERTICAL) - 10
        ):
            self.log_ctrl.ShowPosition(self.log_ctrl.GetLastPosition())

    def on_browse(self, event):
        """Handle browse button click"""
        with wx.DirDialog(
            self,
            message="Choose a directory",
            style=wx.DD_DEFAULT_STYLE | wx.DD_DIR_MUST_EXIST,
        ) as dlg:
            if dlg.ShowModal() == wx.ID_OK:
                directory = dlg.GetPath()
                self._process_directory(directory)

    def _process_directory(self, directory):
        """Process the selected directory"""
        # Disable controls
        self.settings_panel.disable_controls()
        self.browse_btn.Disable()

        def progress_callback(processed, total):
            wx.CallAfter(self.update_progress, processed, total)

        try:
            scraper = CachedScraper(config=self.config)
            scraper.initialize()

            renamer = Renamer(
                scanner=Scanner(), scraper=scraper, config=self.config, app_frame=self
            )
            self._current_renamer = renamer

            renamer.set_progress_callback(progress_callback)

            # Start processing in a thread
            Thread(
                target=lambda: self._run_renamer(renamer, [directory]),
                daemon=True,
            ).start()

        except Exception as e:
            self.logger.error(f"Error processing directory: {str(e)}")
            self.update_progress(0, 0)
            wx.MessageBox(f"Error: {str(e)}", "Error", wx.OK | wx.ICON_ERROR)
            self._enable_controls()

    def update_progress(self, processed, total):
        """Update progress display"""
        if total > 0:
            percentage = (processed / total) * 100
            self.progress_gauge.SetValue(int(percentage))

            # Update status text based on what's being processed
            if processed == total:
                self.status_text.SetLabel("Ready")
                self._enable_controls()
            else:
                self.status_text.SetLabel(f"{processed}/{total}")
        else:
            self.progress_gauge.SetValue(0)
            self.status_text.SetLabel("Ready")
            self._enable_controls()

    def _enable_controls(self):
        """Enable all controls after processing"""
        self.settings_panel.enable_controls()
        self.browse_btn.Enable()

    def _run_renamer(self, renamer, directories):
        """Run renamer and handle completion"""
        try:
            renamer.run(directories)
        except Exception as e:
            self.logger.error("Renamer failed: %s", e, exc_info=True)
        finally:
            self._current_renamer = None
            wx.CallAfter(self.settings_panel.enable_controls)
            wx.CallAfter(self.browse_btn.Enable)
            wx.CallAfter(self.update_progress, 0, 0)

    def _on_language_changed(self, evt):
        """Handle language choice changes"""
        selection = evt.GetSelection()
        if selection != wx.NOT_FOUND:
            value = LOCALE_CHOICES[selection][1]
            self.config.set("locale", value)

    def on_close(self, event):
        """Cleanup all resources before closing."""
        import gc

        # Close all logging handlers
        root_logger = logging.getLogger()
        for handler in root_logger.handlers[:]:
            try:
                handler.close()
            except Exception:
                pass
            root_logger.removeHandler(handler)

        # Cleanup renamer resources if still active
        if self._current_renamer:
            try:
                if hasattr(self._current_renamer, 'playlist_manager'):
                    self._current_renamer.playlist_manager.close()
                if hasattr(self._current_renamer, 'translator'):
                    self._current_renamer.translator.shutdown()
            except Exception:
                pass
            self._current_renamer = None

        gc.collect()
        self.Destroy()
        wx.GetApp().ExitMainLoop()
