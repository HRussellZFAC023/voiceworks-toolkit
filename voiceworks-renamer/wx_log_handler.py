import logging

import wx
import wx.lib.newevent

# create event type
wxLogEvent, EVT_WX_LOG_EVENT = wx.lib.newevent.NewEvent()


class WxLogHandler(logging.Handler):
    """
    A handler class which sends log strings to a wx object
    https://stackoverflow.com/a/2820928
    """

    def __init__(self, wx_dest: wx.Window):
        """
        Initialize the handler
        @param wx_dest: the destination object to post the event to
        """
        logging.Handler.__init__(self)
        self.__wxDest = wx_dest
        self.level = logging.INFO
        # Define module name abbreviations
        self.__name_map = {
            "__main__": "main",
            "scraper.scraper": "scrp",
            "root": "root",
            "renamer": "rena",
            "metadata_handler": "meta",
            "file_manager": "file",
            "scraper.translator": "tran",
            "image_handler": "imag",
            "audio_handler": "audi",
            "scraper.folderIcon_manager": "fold",
            "filesystem": "fsys",
        }

    def flush(self):
        """
        does nothing for this handler
        """

    def emit(self, record):
        """
        Emit a record with properly aligned logger name
        """
        try:
            msg = self.format(record)
            # Get shortened name from map or use last part of module path
            if record.name in self.__name_map:
                display_name = self.__name_map[record.name]
            else:
                name_parts = record.name.split('.')
                display_name = name_parts[-1][:4]  # Take first 4 chars of last part

            # Pad to exactly 4 characters
            name = display_name.ljust(4)
            evt = wxLogEvent(message=f"{name} - {msg}", levelno=record.levelno)
            
            wx.PostEvent(self.__wxDest, evt)
        except (KeyboardInterrupt, SystemExit) as err:
            raise err
        except Exception:
            self.handleError(record)
