import os
import wx

class FileDropTarget(wx.FileDropTarget):
    def __init__(self, window):
        super().__init__()
        self.window = window

    def OnDropFiles(self, x, y, filenames):
        """Run renamer when receiving files dragged by the user"""
        dirname_list = [filename for filename in filenames if os.path.isdir(filename)]
        if hasattr(self.window, '_process_directory'):
            for dirname in dirname_list:
                self.window._process_directory(dirname)
        return True
