import wx
import wx.lib.scrolledpanel as scrolled
import logging

from constants import COLORS, LOCALE_CHOICES, TEMPLATE_HELP


class SettingsPanel(scrolled.ScrolledPanel):
    def __init__(self, parent, config):
        super().__init__(parent)
        self.config = config
        self.SetBackgroundColour(COLORS["panel"])

        # Initialize controls as instance variables
        self.template_ctrl = None

        # Create main vertical sizer
        self.sizer = wx.BoxSizer(wx.VERTICAL)
        self._create_controls()
        self.SetSizer(self.sizer)

        # Adjust scroll rate for smoother scrolling
        self.SetupScrolling(scroll_x=False)

    def _create_template_section(self):
        """Create the template settings section with help text."""
        panel = wx.Panel(self)
        sizer = wx.BoxSizer(wx.VERTICAL)

        # Header
        header = wx.StaticText(panel, label="Template Settings")
        header.SetFont(
            wx.Font(10, wx.FONTFAMILY_DEFAULT, wx.FONTSTYLE_NORMAL, wx.FONTWEIGHT_BOLD)
        )
        sizer.Add(header, 0, wx.BOTTOM, 5)

        # Template settings grid
        settings_grid = wx.FlexGridSizer(cols=2, vgap=5, hgap=10)
        settings_grid.AddGrowableCol(1)

        # Template with default value
        template_label = wx.StaticText(panel, label="Template")
        template_ctrl = wx.TextCtrl(
            panel,
            value=self.config.get(
                "template",
                "[maker_name](rjcode★ratingagerelease_date) work_name cv_list_str ～ tags_list_str",
            ),
            size=(-1, 60),
            style=wx.TE_MULTILINE,
        )
        settings_grid.Add(template_label, 0, wx.ALIGN_CENTER_VERTICAL)
        settings_grid.Add(template_ctrl, 0, wx.EXPAND)

        # Date Format
        date_label = wx.StaticText(panel, label="Date Format")
        date_ctrl = wx.TextCtrl(
            panel, value=self.config.get("renamer_release_date_format", "%d-%m-%y")
        )
        settings_grid.Add(date_label, 0, wx.ALIGN_CENTER_VERTICAL)
        settings_grid.Add(date_ctrl, 0, wx.EXPAND)

        # CV brackets - compact layout
        cv_sizer = wx.BoxSizer(wx.HORIZONTAL)
        cv_left_ctrl = wx.TextCtrl(
            panel, value=self.config.get("cv_list_left", "(CV. "), size=(100, -1)
        )
        cv_right_ctrl = wx.TextCtrl(
            panel, value=self.config.get("cv_list_right", ")"), size=(100, -1)
        )
        cv_sizer.Add(
            wx.StaticText(panel, label="CV Left"),
            0,
            wx.ALIGN_CENTER_VERTICAL | wx.RIGHT,
            5,
        )
        cv_sizer.Add(cv_left_ctrl, 0, wx.RIGHT, 10)
        cv_sizer.Add(
            wx.StaticText(panel, label="CV Right"),
            0,
            wx.ALIGN_CENTER_VERTICAL | wx.RIGHT,
            5,
        )
        cv_sizer.Add(cv_right_ctrl, 0)

        settings_grid.Add(wx.StaticText(panel, label=""), 0)  # Empty cell for alignment
        settings_grid.Add(cv_sizer, 0, wx.EXPAND)

        # Language dropdown
        lang_label = wx.StaticText(panel, label="Language")
        self.lang_ctrl = wx.Choice(panel, choices=[c[0] for c in LOCALE_CHOICES])
        current = self.config.get("locale", "en_us")
        for i, (name, value) in enumerate(LOCALE_CHOICES):
            if value == current:
                self.lang_ctrl.SetSelection(i)
                break
        settings_grid.Add(lang_label, 0, wx.ALIGN_CENTER_VERTICAL)
        settings_grid.Add(self.lang_ctrl, 0, wx.EXPAND)

        sizer.Add(settings_grid, 0, wx.EXPAND | wx.ALL, 5)

        # Help text
        help_text = wx.TextCtrl(
            panel,
            value=TEMPLATE_HELP,
            style=wx.TE_MULTILINE | wx.TE_READONLY | wx.TE_NO_VSCROLL,
            size=(-1, 160),
        )
        help_text.SetBackgroundColour(wx.Colour(245, 245, 245))
        sizer.Add(help_text, 0, wx.EXPAND | wx.TOP, 5)

        # Store controls
        self.template_ctrl = template_ctrl
        self.date_ctrl = date_ctrl
        self.cv_left_ctrl = cv_left_ctrl
        self.cv_right_ctrl = cv_right_ctrl

        # Bind events
        template_ctrl.Bind(
            wx.EVT_TEXT, lambda evt: self._on_setting_changed(evt, "template")
        )
        date_ctrl.Bind(
            wx.EVT_TEXT,
            lambda evt: self._on_setting_changed(evt, "renamer_release_date_format"),
        )
        cv_left_ctrl.Bind(
            wx.EVT_TEXT, lambda evt: self._on_setting_changed(evt, "cv_list_left")
        )
        cv_right_ctrl.Bind(
            wx.EVT_TEXT, lambda evt: self._on_setting_changed(evt, "cv_list_right")
        )
        self.lang_ctrl.Bind(wx.EVT_CHOICE, self._on_language_changed)

        panel.SetSizer(sizer)
        return panel

    def _create_file_settings_section(self):
        """Create the file settings section."""
        file_settings = {
            "save_cover_jpg": self.config.get("save_cover_jpg", True),
            "save_sample_images": self.config.get("save_sample_images", True),
            "include_original_name": self.config.get("include_original_name", True),
            "remove_image_files": self.config.get("remove_image_files", False),
            "use_thumbnail": self.config.get("use_thumbnail", False),
            "overwrite_existing": self.config.get("overwrite_existing", False),
        }
        return self._create_section("File Settings", file_settings)

    def _create_controls(self):
        """Setup all UI controls."""
        self.sizer = wx.BoxSizer(wx.VERTICAL)

        # Template Settings at the top
        template_panel = self._create_template_section()
        self.sizer.Add(template_panel, 0, wx.EXPAND | wx.ALL, 10)

        # Two-column grid for boolean settings
        settings_grid = wx.FlexGridSizer(cols=2, vgap=10, hgap=20)
        settings_grid.AddGrowableCol(0, 1)
        settings_grid.AddGrowableCol(1, 1)

        # Features and File Settings columns
        left_panel = self._create_section("Features", self.config.get("features", {}))
        right_panel = self._create_file_settings_section()

        settings_grid.Add(left_panel, 1, wx.EXPAND)
        settings_grid.Add(right_panel, 1, wx.EXPAND)

        self.sizer.Add(settings_grid, 0, wx.EXPAND | wx.ALL, 10)

        # Playlist Settings below
        playlist_panel = self._create_playlist_section()
        self.sizer.Add(playlist_panel, 0, wx.EXPAND | wx.ALL, 10)

        self.SetSizer(self.sizer)

    def _create_playlist_section(self):
        """Create the playlist settings section."""
        panel = wx.Panel(self)
        sizer = wx.BoxSizer(wx.VERTICAL)

        header = wx.StaticText(panel, label="Playlist Settings")
        header.SetFont(
            wx.Font(10, wx.FONTFAMILY_DEFAULT, wx.FONTSTYLE_NORMAL, wx.FONTWEIGHT_BOLD)
        )
        sizer.Add(header, 0, wx.BOTTOM, 5)

        settings_grid = wx.FlexGridSizer(cols=2, vgap=5, hgap=10)
        settings_grid.AddGrowableCol(1)

        playlist_settings = self.config.get("playlist_settings", {})

        # Create controls
        settings = [
            ("Directory", "playlist_directory", "./playlists", "text"),
            ("Create Genre Playlists", "create_genre_playlists", True, "bool"),
            ("Create Content Playlists", "create_content_playlists", True, "bool"),
            ("Create Artist Playlists", "create_artist_playlists", False, "bool"),
        ]

        for label, key, default, ctrl_type in settings:
            value = playlist_settings.get(key, default)
            settings_grid.Add(
                wx.StaticText(panel, label=label), 0, wx.ALIGN_CENTER_VERTICAL
            )

            if ctrl_type == "bool":
                ctrl = wx.CheckBox(panel)
                ctrl.SetValue(value)
                ctrl.Bind(
                    wx.EVT_CHECKBOX,
                    lambda evt, k=key: self._on_playlist_setting_changed(evt, k),
                )
            elif ctrl_type == "number":
                ctrl = wx.SpinCtrl(panel, min=1, max=1000, initial=value)
                ctrl.Bind(
                    wx.EVT_SPINCTRL,
                    lambda evt, k=key: self._on_playlist_setting_changed(evt, k),
                )
            else:
                ctrl = wx.TextCtrl(panel, value=str(value))
                ctrl.Bind(
                    wx.EVT_TEXT,
                    lambda evt, k=key: self._on_playlist_setting_changed(evt, k),
                )

            settings_grid.Add(ctrl, 0, wx.EXPAND)

        sizer.Add(settings_grid, 0, wx.EXPAND | wx.ALL, 5)
        panel.SetSizer(sizer)
        return panel

    def _on_playlist_setting_changed(self, evt, key):
        """Handle playlist setting changes."""
        ctrl = evt.GetEventObject()
        value = ctrl.GetValue()

        # Update playlist_settings in config
        playlist_settings = self.config.get("playlist_settings", {})
        playlist_settings[key] = value
        self.config.set("playlist_settings", playlist_settings)
        self.config.save_config()

    def _create_section(self, title, settings):
        panel = wx.Panel(self)
        sizer = wx.BoxSizer(wx.VERTICAL)

        # Section header
        header = wx.StaticText(panel, label=title)
        header.SetFont(
            wx.Font(10, wx.FONTFAMILY_DEFAULT, wx.FONTSTYLE_NORMAL, wx.FONTWEIGHT_BOLD)
        )
        sizer.Add(header, 0, wx.BOTTOM, 5)

        # Settings grid
        grid = wx.GridSizer(rows=0, cols=1, vgap=5, hgap=5)

        for key, value in settings.items():
            if isinstance(value, bool):
                ctrl = wx.CheckBox(panel, label=key.replace("_", " ").title())
                ctrl.SetValue(value)
                ctrl.Bind(
                    wx.EVT_CHECKBOX, lambda evt, k=key: self._on_setting_changed(evt, k)
                )
                grid.Add(ctrl, 0, wx.EXPAND)

        sizer.Add(grid, 1, wx.EXPAND)
        panel.SetSizer(sizer)
        return panel

    def _create_text_control(self, key, default, help_text=None):
        """Create a text control with optional help text."""
        ctrl = wx.TextCtrl(self, value=str(default))
        ctrl.key = key
        if help_text:
            ctrl.SetToolTip(help_text)
        ctrl.Bind(wx.EVT_TEXT, lambda evt: self._on_setting_changed(evt, key))
        return ctrl

    def _create_choice_control(self, key, choices, default):
        """Create a choice control (dropdown)."""
        ctrl = wx.Choice(self, choices=[c[0] for c in choices])
        ctrl.key = key
        ctrl.choices = choices
        # Set default selection
        for i, (_, value) in enumerate(choices):
            if value == default:
                ctrl.SetSelection(i)
                break
        ctrl.Bind(wx.EVT_CHOICE, lambda evt: self._on_choice_changed(evt, key))
        return ctrl

    def _create_checkbox_control(self, key, default):
        """Create a checkbox control."""
        ctrl = wx.CheckBox(self)
        ctrl.key = key
        ctrl.SetValue(default)
        ctrl.Bind(wx.EVT_CHECKBOX, lambda evt: self._on_setting_changed(evt, key))
        return ctrl

    def _create_spinctrl(self, key, min_val, max_val, default):
        """Create a spin control for numbers."""
        ctrl = wx.SpinCtrl(self, min=min_val, max=max_val, initial=default)
        ctrl.key = key
        ctrl.Bind(wx.EVT_SPINCTRL, lambda evt: self._on_setting_changed(evt, key))
        return ctrl

    def _create_dirpicker_control(self, key, default):
        """Create a directory picker control."""
        ctrl = wx.DirPickerCtrl(self, path=default)
        ctrl.key = key
        ctrl.Bind(
            wx.EVT_DIRPICKER_CHANGED, lambda evt: self._on_dirpicker_changed(evt, key)
        )
        return ctrl

    def _on_choice_changed(self, evt, key):
        """Handle choice control changes."""
        ctrl = evt.GetEventObject()
        selection = ctrl.GetSelection()
        if selection != wx.NOT_FOUND:
            value = ctrl.choices[selection][1]
            self._update_config(key, value)

    def _on_dirpicker_changed(self, evt, key):
        """Handle directory picker changes."""
        ctrl = evt.GetEventObject()
        self._update_config(key, ctrl.GetPath())

    def _update_config(self, key, value):
        """Update config with new value."""
        # Handle nested keys (e.g., playlist_settings.create_genre_playlists)
        if ("." in key):
            section, subkey = key.split(".", 1)
            current = self.config.get(section, {})
            if not isinstance(current, dict):
                current = {}
            current[subkey] = value
            self.config.set(section, current)
        else:
            self.config.set(key, value)

    def _on_setting_changed(self, evt, key):
        """Handle setting changes and update config"""
        ctrl = evt.GetEventObject()
        value = ctrl.GetValue()

        if key.startswith("enable_"):
            # Handle features settings
            features = self.config.get("features", {})
            features[key] = value
            self.config.set("features", features)
        else:
            # Handle direct settings
            self.config.set(key, value)

        # Save config to file immediately
        self.config.save_config()
        logging.debug(f"Updated setting {key} to {value}")

    def _on_language_changed(self, evt):
        """Handle language choice changes"""
        selection = evt.GetSelection()
        if selection != wx.NOT_FOUND:
            value = LOCALE_CHOICES[selection][1]
            self.config.set("locale", value)
            # Save config to file
            self.config.save_config()
            logging.info(f"Language changed to: {value}")

    def disable_controls(self):
        """Disable all controls during processing"""
        for ctrl in self.GetChildren():
            if isinstance(ctrl, (wx.CheckBox, wx.TextCtrl)):
                ctrl.Disable()

    def enable_controls(self):
        """Enable all controls after processing"""
        for ctrl in self.GetChildren():
            if isinstance(ctrl, (wx.CheckBox, wx.TextCtrl)):
                ctrl.Enable()

    def _add_section(self, title, settings):
        """Create a section with settings."""
        header = wx.StaticText(self, label=title)
        header.SetForegroundColour(COLORS["text"])
        font = header.GetFont()
        font.SetWeight(wx.FONTWEIGHT_BOLD)
        header.SetFont(font)
        self.sizer.Add(header, 0, wx.ALL, 10)

        settings_grid = wx.FlexGridSizer(cols=2, vgap=5, hgap=10)

        for key, value in settings.items():
            display_name = key.replace("_", " ").title()
            label = wx.StaticText(self, label=display_name)

            if isinstance(value, bool):
                ctrl = wx.CheckBox(self)
                ctrl.SetValue(value)
                ctrl.Bind(
                    wx.EVT_CHECKBOX, lambda evt, k=key: self._on_setting_changed(evt, k)
                )
            else:
                ctrl = wx.TextCtrl(self, value=str(value))
                ctrl.Bind(
                    wx.EVT_TEXT, lambda evt, k=key: self._on_setting_changed(evt, k)
                )

            settings_grid.Add(label, 0, wx.ALIGN_CENTER_VERTICAL)
            settings_grid.Add(ctrl, 0, wx.EXPAND)

        self.sizer.Add(settings_grid, 0, wx.ALL | wx.EXPAND, 10)
