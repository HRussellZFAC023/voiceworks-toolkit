import asyncio
import os
import sys
import wx
from modern_frame import ModernFrame

VERSION = "1.0.0"

if sys.platform.startswith("win"):
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())


def get_application_path():
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return sys._MEIPASS
    return os.path.dirname(__file__)


if __name__ == "__main__":
    app_path = get_application_path()
    icon_path = os.path.join(app_path, "favicon.ico")
    config_path = os.path.join(app_path, "config.json")

    app = wx.App(False)
    frame = ModernFrame(None, config_path)
    frame.SetIcon(wx.Icon(icon_path))
    frame.SetTitle(f"DLSite Doujin Work Renaming Tool v{VERSION}")
    frame.Show(True)
    app.MainLoop()
