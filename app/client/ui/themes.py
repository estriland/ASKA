"""Two app palettes; restyle existing widgets without rebuilding chat or audio.

The colour aliases adapt existing Qt styles only. Message HTML, source text,
images and model payloads never pass through this substitution.
"""
from __future__ import annotations

import re
import sys

from PyQt6 import sip
from PyQt6.QtCore import QObject, QEvent, Qt
from PyQt6.QtGui import QColor, QPalette
from PyQt6.QtWidgets import QApplication, QWidget


THEME_NAMES = {'night': '深色', 'unit02': '二号机 · 红橙'}
PALETTES = {
    'night': {
        'window': '#141a22', 'surface': '#1b222c', 'field': '#171e28',
        'text': '#eef2f8', 'muted': '#a5b4c7', 'disabled': '#718092',
        'selection': '#304058', 'border': '#344152', 'accent': '#acc8ed',
        'card': '#202934', 'soft': '#273442', 'control': '#a9c8ec', 'on_control': '#172636',
        'brand': '#b55238', 'banner': '#252f3b', 'switch_off': '#435063',
        'bubble_self':'#273541', 'bubble_peer':'#243143', 'bubble_edge':'#435269',
        'scroll': '#8f96a5', 'graph_top': '#151c25', 'graph_bottom': '#15141e',
        'graph_card': '#1b232f', 'graph_border': '#465569',
        'input': '#78b9ee', 'state': '#dcb782', 'compute': '#8fc9be', 'output': '#c39bdc',
        'voice_start': '#38d8e8', 'voice_end': '#ff3fb4', 'mic_end': '#7657ff',
        'glow': '#ff2dc3', 'edge': '#82969d', 'edge_read': '#89b3c5', 'edge_write': '#e9b57f',
    },
    'unit02': {
        'window': '#1a191c', 'surface': '#232124', 'field': '#201e21',
        # Shared neutral foreground keeps existing rich text / math legible
        # without rerendering the user's conversation on a palette change.
        'text': '#f2ece6', 'muted': '#bfb0a6', 'disabled': '#887d77',
        'selection': '#50342f', 'border': '#453b3b', 'accent': '#f0ae8a',
        'card': '#2a2527', 'soft': '#382d2e', 'control': '#efab88', 'on_control': '#35201b',
        'brand': '#c26243', 'banner': '#3b2b2d', 'switch_off': '#53474a',
        'bubble_self':'#363236', 'bubble_peer':'#413030', 'bubble_edge':'#574141',
        'scroll': '#b29b8d', 'graph_top': '#231c1b', 'graph_bottom': '#1c181a',
        'graph_card': '#302522', 'graph_border': '#755348',
        'input': '#f2b65f', 'state': '#d7c39a', 'compute': '#dca796', 'output': '#f47a5d',
        'voice_start': '#f4b561', 'voice_end': '#ec5a3f', 'mic_end': '#cf895c',
        'glow': '#f07850', 'edge': '#bf9987', 'edge_read': '#d0b492', 'edge_write': '#f0a36b',
    },
}

# Existing style colours grouped by their visual role. Warning/success/hangup
# colours intentionally retain their meaning rather than inheriting accent.
_WARM_GROUPS = {
    '#1c1818': '#181a1f #1e1e1e',
    '#251e1d': '#202329 #20252e',
    '#201b1b': '#171920 #151820',
    '#2d2523': '#24272e #25282f #242932 #22252b',
    '#2f2826': '#2b2d32',
    '#41332e': '#343943 #353c47 #3a3d44',
    '#312724': '#242831',
    '#352b27': '#2b2f37 #2d3139 #2b3039',
    '#514039': '#373b45 #343b48 #363c47 #3b404b #414956 #394352',
    '#42342e': '#30343c #343840 #31353e #303541 #3b3e46',
    '#6b4c3e': '#505663 #626c7b',
    '#57342c': '#3c465f #343d52 #253347 #405170 #4b6384 #3a4050',
    '#ad4432': '#3e506f',
    '#c7593c': '#4a5e80',
    '#d27e52': '#53698f',
    '#f0a36b': '#778fbd #a8c8ed #c786b4 #d6a4c8 #e064c4',
    '#b86b46': '#9b4dca',
    '#362e2b': '#3a3f4b',
    '#4a2b26': '#2d3a52',
    '#b4a29a': '#8f96a5 #9da4b2 #9199a8 #8495a9 #849aab',
    '#bba99f': '#9aa9ba #9ea6b3',
    '#e4c8ba': '#c7ddf2 #b9c9dd',
    '#58483f': '#555963 #3a3e48',
    '#635048': '#535967',
    '#827570': '#626874 #6f7580',
    '#8e776a': '#7f90a4 #697582',
    '#c24d34': '#326ac3 #e91e63',
    '#462a21': '#173f4b #532445',
    '#302725': '#252a33 #292d35 #2a3039 #292f3a #242832 #26364f #252b48',
}
_WARM_ALIASES = {source: target for target, sources in _WARM_GROUPS.items() for source in sources.split()}
_HEX = re.compile(r'#[0-9a-fA-F]{6}\b')


def theme_id(value=None):
    if value is None:
        app = QApplication.instance()
        value = app.property('asukaTheme') if app else None
    return value if value in THEME_NAMES else 'night'


def colors():
    return PALETTES[theme_id()]


def style_color(value):
    """Resolve a legacy UI paint colour (never call on user content)."""
    return _WARM_ALIASES.get(value.lower(), value) if theme_id() == 'unit02' else value


def render_style(source):
    if callable(source):
        return source(colors())
    return _HEX.sub(lambda match: style_color(match.group(0)), source)


def desktop_surface_style(c):
    return f'''
        QPushButton#groupActions::menu-indicator,QPushButton#cardTools::menu-indicator,QPushButton#sidebarRecords::menu-indicator {{
            subcontrol-origin:padding;subcontrol-position:center right;right:4px;}}
        QPushButton#callHistoryToggle {{text-align:left;padding:6px;background:transparent;border:1px solid transparent;}}
        QPushButton#callHistoryToggle:hover {{background:{c['field']};}}
        QTabBar#searchModes::tab {{padding:8px 14px;color:{c['muted']};border:0;border-bottom:2px solid {c['border']};}}
        QTabBar#searchModes::tab:selected {{color:{c['text']};border-bottom-color:{c['accent']};}}
        QMenu::separator {{height:1px;background:{c['border']};margin:4px 6px;}}
        QSlider#backgroundOpacitySlider::sub-page:horizontal {{background:{c['accent']};}}
        QSlider#backgroundOpacitySlider::handle:horizontal {{background:{c['accent']};}}
        QPushButton:focus,QToolButton:focus,QLineEdit:focus,QPlainTextEdit:focus,QComboBox:focus,QSpinBox:focus,QDoubleSpinBox:focus,
        QPushButton#groupCreate:focus,QPushButton#groupActions:focus,QPushButton#historyEarlier:focus,QPushButton#sidebarSearch:focus,
        QPushButton#sidebarRecords:focus,QPushButton#navButton:focus,QPushButton#primaryButton:focus,QPushButton#configFileLink:focus,
        QListWidget#sessionList::item:focus,QListWidget#settingsSections::item:focus {{border:1px solid {c['accent']};}}

        QMainWindow, QWidget#chatPage, QStackedWidget#pageStack, QScrollArea#settingsScroll,
        QWidget#settingsCanvas {{ background:{c['window']}; }}
        QWidget#conversationSidebar, QStackedWidget#sidebarPages {{ background:{c['window']}; }}
        QLabel#pageTitle {{font-size:25px;font-weight:700;color:{c['text']};}}
        QLabel#cardTitle {{font-size:16px;font-weight:650;color:{c['text']};}}
        QLabel#conversationName {{font-size:17px;font-weight:650;color:{c['text']};}}
        QLabel#conversationTitle {{font-size:12px;font-weight:400;color:{c['muted']};padding:0;}}
        QLabel#profileName {{font-size:20px;font-weight:650;color:#fff3e9;background:transparent;}}
        QLabel#profileNameJa {{font-size:11px;color:#ded8d5;background:transparent;}}
        QLabel#cardDescription,QLabel#mutedLabel {{color:{c['muted']};font-size:12px;}}
        QLabel#sectionLabel {{color:{c['muted']};font-size:12px;padding:4px 3px;}}
        QFrame#settingsCard {{background:{c['card']};border:1px solid {c['border']};border-radius:13px;}}
        QFrame#sidebarRule {{background:{c['border']};border:0;max-height:1px;}}
        QToolButton#sidebarToggle {{background:transparent;border:1px solid transparent;border-radius:7px;padding:3px;}}
        QToolButton#sidebarToggle:hover,QToolButton#sidebarToggle:pressed {{background:{c['soft']};}}
        QToolButton#sidebarToggle:focus {{border-color:{c['accent']};}}
        QPushButton#sidebarSearch {{color:{c['muted']};background:{c['field']};border:1px solid {c['border']};
            border-radius:9px;text-align:left;padding:8px 10px;}}
        QPushButton#sidebarRecords,QPushButton#navButton {{background:transparent;text-align:left;border:1px solid transparent;border-radius:8px;padding:8px 11px;}}
        QPushButton#sidebarSearch:hover,QPushButton#sidebarRecords:hover,QPushButton#navButton:hover {{background:{c['soft']};}}
        QPushButton#historyEarlier,QPushButton#cardTools {{background:transparent;color:{c['muted']};border:1px solid transparent;border-radius:6px;padding:4px 7px;}}
        QPushButton#cardTools {{padding-right:18px;}}
        QFrame#relationshipCall {{background:{c['card']};border:1px solid {c['border']};border-radius:10px;}}
        QListWidget#sessionList,QListWidget#settingsSections {{background:transparent;color:{c['text']};border:1px solid transparent;outline:0;padding:0;}}
        QListWidget#sessionList::item:hover,QListWidget#settingsSections::item:hover {{background:{c['soft']};}}
        QPushButton#navButton:checked,QListWidget#settingsSections::item:selected,QListWidget#sessionList::item:selected {{
            background:{c['selection']};color:{c['text']};border:1px solid transparent;}}
        QListWidget#sessionList::item,QListWidget#settingsSections::item {{
            padding:6px 10px;margin:2px 0;border:1px solid transparent;border-radius:8px;}}
        QListWidget#sessionList:focus,QListWidget#settingsSections:focus {{border:1px solid transparent;}}
        QListWidget#sessionList::item:focus,QListWidget#settingsSections::item:focus {{border:1px solid {c['accent']};}}
        QPushButton#groupCreate,QPushButton#groupActions {{color:{c['accent']};background:{c['soft']};
            border:1px solid transparent;border-radius:8px;padding:2px;}}
        QPushButton#groupCreate:hover,QPushButton#groupActions:hover {{border:1px solid {c['accent']};}}
        QPushButton#groupActions::menu-indicator {{width:0;}}
        QFrame#settingsCard QLineEdit,QFrame#settingsCard QComboBox,QFrame#settingsCard QSpinBox,
        QFrame#settingsCard QDoubleSpinBox,QFrame#settingsCard QPlainTextEdit {{
            background:{c['field']};color:{c['text']};border:1px solid {c['border']};border-radius:7px;padding:6px 9px;}}
        QFrame#settingsCard QLineEdit:focus,QFrame#settingsCard QComboBox:focus,
        QFrame#settingsCard QPlainTextEdit:focus {{border:1px solid {c['accent']};}}
        QFrame#settingsCard QComboBox::drop-down {{
            subcontrol-origin:padding;subcontrol-position:center right;width:22px;border:0;background:transparent;}}
        QPushButton#primaryButton {{background:{c['control']};color:{c['on_control']};font-weight:650;
            border:1px solid {c['control']};border-radius:8px;padding:7px 14px;}}
        QPushButton#primaryButton:hover {{background:{c['accent']};color:{c['on_control']};}}
        QPushButton#primaryButton:disabled {{background:{c['soft']};border-color:{c['border']};color:{c['disabled']};}}
        QPushButton#detailDisclosure {{text-align:left;color:{c['accent']};border:0;border-radius:6px;
            background:transparent;padding:5px 3px;}}
        QPushButton#detailDisclosure:hover,QPushButton#cardTools:hover {{background:{c['soft']};}}
        QMenu {{background:{c['card']};color:{c['text']};border:1px solid {c['border']};border-radius:9px;padding:5px;}}
        QMenu::item {{padding:7px 25px 7px 14px;border-radius:5px;}}
        QMenu::item:selected {{background:{c['selection']};color:{c['text']};}}
    '''


def set_theme_style(widget, source):
    # Keep the original, so changing themes repeatedly never compounds edits.
    widget._asuka_style_source = source
    widget.setStyleSheet(render_style(source))


def scrollbar_style():
    color = QColor(colors()['scroll'])
    rgb = f'{color.red()}, {color.green()}, {color.blue()}'
    return f'''
        QScrollBar:vertical {{background:transparent; width:8px; margin:2px 1px; border:0;}}
        QScrollBar:horizontal {{background:transparent; height:8px; margin:1px 2px; border:0;}}
        QScrollBar::handle:vertical {{background:rgba({rgb},72); min-height:30px; border-radius:3px;}}
        QScrollBar::handle:horizontal {{background:rgba({rgb},72); min-width:30px; border-radius:3px;}}
        QScrollBar::handle:hover {{background:rgba({rgb},150);}}
        QScrollBar::handle:pressed {{background:rgba({rgb},200);}}
        QScrollBar::add-line, QScrollBar::sub-line {{background:transparent; border:0; width:0; height:0;}}
        QScrollBar::add-page, QScrollBar::sub-page {{background:transparent; border:0;}}
        QScrollBar::up-arrow, QScrollBar::down-arrow,
        QScrollBar::left-arrow, QScrollBar::right-arrow {{background:transparent; border:0; width:0; height:0;}}
        QAbstractScrollArea::corner {{background:transparent; border:0;}}
    '''


def apply_native_frame(widget):
    """Own native windows only. Win10 dark caption; Win11 adds palette colours."""
    app = QApplication.instance()
    if sys.platform != 'win32' or not app or app.platformName() != 'windows':
        return {'supported': False}
    if not widget.isWindow() or widget.windowType() not in (Qt.WindowType.Window, Qt.WindowType.Dialog):
        return {'supported': False}
    if not widget.isVisible() or not widget.testAttribute(Qt.WidgetAttribute.WA_WState_Created):
        return {'supported': False}
    import ctypes
    from ctypes import wintypes
    results = {'supported': True, 'build': sys.getwindowsversion().build}
    try:
        dwm = ctypes.WinDLL('dwmapi')
        setter = dwm.DwmSetWindowAttribute
        setter.argtypes = [wintypes.HWND, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD]
        setter.restype = ctypes.c_long
        hwnd = int(widget.winId())
        def set_attr(attr, value):
            result = setter(hwnd, attr, ctypes.byref(value), ctypes.sizeof(value))
            results[str(attr)] = int(result)
            return result
        if set_attr(20, wintypes.BOOL(1)) != 0:
            set_attr(19, wintypes.BOOL(1))
        if results['build'] >= 22000:
            # The custom frame draws its own themed 1px outline. Suppress the
            # extra Win11 DWM border instead of drawing two competing outlines.
            custom = bool(widget.property('asukaCustomFrame'))
            if custom:
                set_attr(34, wintypes.DWORD(0xFFFFFFFE))  # DWMWA_COLOR_NONE
            attributes = () if custom else ((34, 'border'), (35, 'window'), (36, 'text'))
            for attr, token in attributes:
                c = QColor(colors()[token])
                set_attr(attr, wintypes.DWORD(c.red() | c.green() << 8 | c.blue() << 16))
        # Request non-client repaint without moving/resizing/activating a window.
        position = ctypes.WinDLL('user32').SetWindowPos
        position.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int,
                             ctypes.c_int, ctypes.c_int, wintypes.UINT]
        position.restype = wintypes.BOOL
        position(hwnd, None, 0, 0, 0, 0, 0x0027 | 0x0010)
    except (OSError, AttributeError) as exc:
        results['error'] = type(exc).__name__
    widget._asuka_native_frame = results
    return results


class _NativeFrameFilter(QObject):
    def eventFilter(self, watched, event):
        if isinstance(watched, QWidget) and event.type() in (QEvent.Type.Show, QEvent.Type.WinIdChange, QEvent.Type.WindowActivate, QEvent.Type.WindowDeactivate):
            apply_native_frame(watched)
        return False


def apply_theme(value):
    """Single application palette. No model/settings writes or chat reconstruction."""
    app = QApplication.instance()
    value = theme_id(value)
    if not app.property('feiniaoTypeface'):
        if app.style().objectName().lower()!='fusion':
            app.setStyle('Fusion')
        font=app.font()
        font.setFamilies(['Microsoft YaHei UI','Inter','Segoe UI','Yu Gothic UI'])
        font.setPointSizeF(10)
        app.setFont(font)
        app.setProperty('feiniaoTypeface',True)
    app.setProperty('asukaTheme', value)
    c = colors()
    palette = QPalette()
    for role, token in {
        'Window': 'window', 'Base': 'field', 'AlternateBase': 'surface',
        'Text': 'text', 'WindowText': 'text', 'Button': 'surface', 'ButtonText': 'text',
        'Highlight': 'selection', 'HighlightedText': 'text', 'ToolTipBase': 'surface',
        'ToolTipText': 'text', 'Link': 'accent', 'PlaceholderText': 'muted',
        'Mid': 'border', 'Dark': 'border', 'Light': 'border', 'Midlight': 'field',
        'Shadow': 'window', 'BrightText': 'text', 'LinkVisited': 'accent', 'Accent': 'accent',
    }.items():
        if hasattr(QPalette.ColorRole, role):
            palette.setColor(getattr(QPalette.ColorRole, role), QColor(c[token]))
    for role in (QPalette.ColorRole.Text, QPalette.ColorRole.WindowText, QPalette.ColorRole.ButtonText):
        palette.setColor(QPalette.ColorGroup.Disabled, role, QColor(c['disabled']))
    app.setPalette(palette)
    app.setStyleSheet(scrollbar_style() + f'''
        QDialog {{background:{c['window']}; color:{c['text']};}}
        QSplitter::handle {{background:{c['border']};}}
        QToolTip {{background:{c['surface']}; color:{c['text']}; border:1px solid {c['border']}; padding:6px;}}
    ''')
    if not hasattr(app, '_asuka_frame_filter'):
        app._asuka_frame_filter = _NativeFrameFilter(app)
        app.installEventFilter(app._asuka_frame_filter)
    for widget in app.allWidgets():
        if sip.isdeleted(widget):
            continue
        source = getattr(widget, '_asuka_style_source', None)
        if source is not None:
            widget.setStyleSheet(render_style(source))
        widget.update()
    for window in app.topLevelWidgets():
        apply_native_frame(window)
    return value
