"""App-owned title bars with the pinned qframelesswindow Windows backend.

Only native frame handling is delegated. The existing QMainWindow/QDialog
content, closeEvent, audio workers and conversation lifecycle stay in place.
"""
from __future__ import annotations

import sys

from PyQt6.QtCore import QEvent, QPoint, QRectF, Qt, QTimer
from PyQt6.QtGui import QColor, QKeySequence, QPainter, QPen, QShortcut
from PyQt6.QtWidgets import (QApplication, QDialog, QHBoxLayout, QLabel,
                             QMainWindow, QPushButton, QVBoxLayout, QWidget)
from .themes import colors, set_theme_style


class WindowButton(QPushButton):
    def __init__(self, kind, window, parent):
        super().__init__(parent)
        self.kind, self.host = kind, window
        self.setFixedSize(44, 34)
        self.setAutoDefault(False)
        self.setDefault(False)
        # Match native caption buttons: don't steal initial/editor Tab focus.
        self.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self.setCursor(Qt.CursorShape.ArrowCursor)
        self.setAccessibleName({'minimize': '最小化', 'maximize': '最大化', 'close': '关闭'}[kind])
        self.setToolTip(self.accessibleName())

    def paintEvent(self, event):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        c = colors()
        if self.underMouse() or self.isDown() or self.hasFocus():
            fill = QColor('#c74343' if self.kind == 'close' else c['selection'])
            if self.isDown():
                fill = fill.darker(120)
            p.fillRect(self.rect(), fill)
        p.setPen(QPen(QColor(c['text']), 1.1))
        x, y = self.width()/2, self.height()/2
        if self.kind == 'minimize':
            p.drawLine(QPoint(round(x-5), round(y+2)), QPoint(round(x+5), round(y+2)))
        elif self.kind == 'close':
            p.drawLine(QPoint(round(x-4), round(y-4)), QPoint(round(x+4), round(y+4)))
            p.drawLine(QPoint(round(x+4), round(y-4)), QPoint(round(x-4), round(y+4)))
        elif self.host.isMaximized() or self.host.isFullScreen():
            p.drawRect(QRectF(x-2, y-5, 7, 7))
            p.fillRect(QRectF(x-5, y-2, 7, 7), QColor(c['selection'] if self.underMouse() else c['window']))
            p.drawRect(QRectF(x-5, y-2, 7, 7))
        else:
            p.drawRect(QRectF(x-4, y-4, 8, 8))
        p.end()


class AppTitleBar(QWidget):
    def __init__(self, window, dialog=False):
        super().__init__(window)
        self.host = window
        self.setObjectName('appTitleBar')
        self.setFixedHeight(34)
        row = QHBoxLayout(self)
        row.setContentsMargins(16, 0, 0, 0)
        row.setSpacing(8)
        self.title = QLabel(window.windowTitle(), self)
        self.title.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents)
        title_style = 'font-size:12px;' if dialog else 'font-size:16px;font-weight:650;'
        set_theme_style(self.title, lambda c: f'background:transparent;color:{c["text"]};{title_style}')
        row.addWidget(self.title)
        row.addStretch()
        self.minimize = WindowButton('minimize', window, self)
        self.maximize = WindowButton('maximize', window, self)
        self.close_button = WindowButton('close', window, self)
        self.minimize.clicked.connect(window.showMinimized)
        self.maximize.clicked.connect(window.toggle_maximized)
        self.close_button.clicked.connect(window.close)
        for button in (self.minimize, self.maximize, self.close_button):
            row.addWidget(button)
        if dialog:
            self.minimize.hide()
            self.maximize.hide()
        self._dialog = dialog
        window.windowTitleChanged.connect(self.title.setText)

    def paintEvent(self, event):
        p = QPainter(self)
        p.fillRect(self.rect(), QColor(colors()['window']))
        p.end()

    def mouseMoveEvent(self, event):
        if (event.buttons() & Qt.MouseButton.LeftButton and self.host._native_frame_class is not None
                and not self.host.isFullScreen()):
            buttons = (self.minimize, self.maximize, self.close_button)
            if any(button.isDown() for button in buttons):
                return
            if not 0 < event.position().x() < self.width() - sum(b.width() for b in buttons if b.isVisible()):
                return
            # Use the upstream title bar's Windows path (WM_SYSCOMMAND),
            # leaving restoring under the pointer and snapping to the OS.
            from qframelesswindow.utils import startSystemMove
            startSystemMove(self.host, event.globalPosition().toPoint())

    def mouseDoubleClickEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton and not self._dialog:
            self.host.toggle_maximized()

    def contextMenuEvent(self, event):
        self.host.open_system_menu(event.globalPos())


class _WindowFrame:
    BORDER_WIDTH = 6

    def _setup_frame(self, *, dialog=False):
        self._native_frame_class = None
        self._frame_dialog = dialog
        self._isResizeEnabled = True
        self._frame_error = None
        self._custom_frame = False
        self._maximized_before_fullscreen = False
        self._exit_fullscreen_shortcut = None
        if not dialog:
            self._exit_fullscreen_shortcut = QShortcut(QKeySequence('Escape'), self)
            self._exit_fullscreen_shortcut.activated.connect(self.exit_fullscreen)
            self._exit_fullscreen_shortcut.setEnabled(False)
        platform = QApplication.instance().platformName()
        if sys.platform == 'win32' and platform == 'windows':
            try:
                # Do not instantiate the library's QWidget: its constructor
                # replaces content geometry and eagerly builds another bar.
                from qframelesswindow.windows import WindowsFramelessWindow, WindowsWindowEffect
                self.windowEffect = WindowsWindowEffect(self)
                self._native_frame_class = WindowsFramelessWindow
                # All fields required by the native handler exist before winId
                # creates a real hidden HWND. Offscreen never enters this path.
                WindowsFramelessWindow.updateFrameless(self)
                if dialog:
                    import win32con
                    import win32gui
                    hwnd = int(self.winId())
                    style = win32gui.GetWindowLong(hwnd, win32con.GWL_STYLE)
                    win32gui.SetWindowLong(hwnd, win32con.GWL_STYLE,
                                          style & ~(win32con.WS_MINIMIZEBOX | win32con.WS_MAXIMIZEBOX))
                self.windowHandle().screenChanged.connect(self._frame_screen_changed)
                self._custom_frame = True
            except (ImportError, OSError) as exc:
                self._native_frame_class = None
                self._frame_error = str(exc)
                self.setWindowFlag(Qt.WindowType.FramelessWindowHint, False)
        elif platform in ('offscreen', 'minimal'):
            # Paint/layout checks use exactly the same bar, but no Windows API,
            # winId, native hit testing or pretend HWND.
            self.setWindowFlag(Qt.WindowType.FramelessWindowHint, True)
            self._custom_frame = True
        self.setProperty('asukaCustomFrame', self._custom_frame)
        self.title_bar = AppTitleBar(self, dialog) if self._custom_frame else None
        self._update_frame_state()
        if self._native_frame_class is not None:
            self._system_menu_shortcut = QShortcut(QKeySequence('Alt+Space'), self)
            self._system_menu_shortcut.activated.connect(
                lambda: self.open_system_menu(self.mapToGlobal(QPoint(0, 34))))

    def _frame_screen_changed(self, _screen):
        if self._native_frame_class is None:
            return
        import win32con
        import win32gui
        win32gui.SetWindowPos(int(self.winId()), None, 0, 0, 0, 0,
                             win32con.SWP_NOMOVE | win32con.SWP_NOSIZE |
                             win32con.SWP_NOZORDER | win32con.SWP_NOACTIVATE | win32con.SWP_FRAMECHANGED)

    def _update_frame_state(self):
        shortcut = getattr(self, '_exit_fullscreen_shortcut', None)
        if shortcut is not None:
            shortcut.setEnabled(self.isFullScreen())
        if not getattr(self, '_custom_frame', False):
            return
        margin = 0 if self.isMaximized() or self.isFullScreen() else 1
        self.setContentsMargins(margin, margin, margin, margin)
        if getattr(self, 'title_bar', None) is not None:
            text = '还原' if self.isMaximized() or self.isFullScreen() else '最大化'
            self.title_bar.maximize.setAccessibleName(text)
            self.title_bar.maximize.setToolTip(text)
            self.title_bar.maximize.update()
            self.title_bar.update()
        self.update()

    def changeEvent(self, event):
        super().changeEvent(event)
        if (event.type() == QEvent.Type.WindowStateChange and self.isFullScreen()
                and not event.oldState() & Qt.WindowState.WindowFullScreen):
            self._maximized_before_fullscreen = bool(event.oldState() & Qt.WindowState.WindowMaximized)
        if event.type() in (QEvent.Type.WindowStateChange, QEvent.Type.ActivationChange):
            self._update_frame_state()

    def paintEvent(self, event):
        super().paintEvent(event)
        if getattr(self, '_custom_frame', False) and not self.isMaximized() and not self.isFullScreen():
            p = QPainter(self)
            p.setPen(QPen(QColor(colors()['border']), 1))
            p.drawRect(QRectF(self.rect()).adjusted(.5, .5, -.5, -.5))
            p.end()

    def exit_fullscreen(self):
        if self.isFullScreen():
            was_maximized = self._maximized_before_fullscreen
            self.showNormal()
            if was_maximized:
                # Qt's Windows backend queues the saved normal placement on
                # fullscreen exit. Apply the preceding maximize on the next
                # event-loop pass so that placement cannot undo it.
                QTimer.singleShot(0, self._restore_maximized_frame)

    def _restore_maximized_frame(self):
        if self.isVisible() and not self.isMinimized() and not self.isFullScreen() and not self.isMaximized():
            self.toggle_maximized()

    def toggle_maximized(self):
        if self.isFullScreen():
            self.exit_fullscreen()
        elif self._native_frame_class is not None:
            # Upstream uses WM_SYSCOMMAND for Qt >= 6.8, preserving native
            # maximize/restore geometry and title button state.
            from qframelesswindow.utils import toggleMaxState
            toggleMaxState(self)
        elif self.isMaximized():
            self.showNormal()
        else:
            self.showMaximized()

    def open_system_menu(self, point):
        if self._native_frame_class is None:
            return
        import win32con
        import win32gui
        hwnd = int(self.winId())
        menu = win32gui.GetSystemMenu(hwnd, False)
        expanded = self.isMaximized() or self.isFullScreen()
        for command, enabled in ((win32con.SC_RESTORE, expanded),
                                 (win32con.SC_MOVE, not expanded),
                                 (win32con.SC_SIZE, not expanded),
                                 (win32con.SC_MINIMIZE, not self._frame_dialog),
                                 (win32con.SC_MAXIMIZE, not expanded and not self._frame_dialog)):
            win32gui.EnableMenuItem(menu, command,
                                    win32con.MF_ENABLED if enabled else win32con.MF_GRAYED)
        # Qt global coordinates are logical pixels; Windows uses physical.
        local = self.mapFromGlobal(point)
        ratio = self.devicePixelRatioF()
        position = win32gui.ClientToScreen(hwnd, (round(local.x() * ratio), round(local.y() * ratio)))
        command = win32gui.TrackPopupMenu(menu, win32con.TPM_RETURNCMD | win32con.TPM_RIGHTBUTTON,
                                          *position, 0, hwnd, None)
        if command == win32con.SC_RESTORE and self.isFullScreen():
            self.exit_fullscreen()
        elif command:
            win32gui.PostMessage(hwnd, win32con.WM_SYSCOMMAND, command, 0)

    def nativeEvent(self, event_type, message):
        backend = getattr(self, '_native_frame_class', None)
        if backend is None:
            return super().nativeEvent(event_type, message)
        from ctypes import cast
        from ctypes.wintypes import LPRECT, MSG
        from qframelesswindow.utils import win32_utils
        from qframelesswindow.windows.c_structures import LPNCCALCSIZE_PARAMS
        msg = MSG.from_address(int(message))
        if msg.message == 0x0084:  # WM_NCHITTEST coordinates are physical pixels.
            self.BORDER_WIDTH = max(4, round(6 * self.devicePixelRatioF()))
        # Our palette owns the border; do not let the library replace it with
        # the OS accent when focus changes (only active on Windows 11).
        if msg.message in (0x0007, 0x0008):  # WM_SETFOCUS / WM_KILLFOCUS
            return False, 0
        result = backend.nativeEvent(self, event_type, message)
        # 0.8.2's first auto-hide taskbar case repeats LEFT instead of TOP.
        # Correct only that known native rectangle adjustment; no vendored fork.
        if msg.message == 0x0083 and result[0]:  # WM_NCCALCSIZE
            taskbar = win32_utils.Taskbar
            if (win32_utils.isMaximized(msg.hWnd) or win32_utils.isFullScreen(msg.hWnd)) and taskbar.isAutoHide():
                position = taskbar.getPosition(msg.hWnd)
                rect = cast(msg.lParam, LPNCCALCSIZE_PARAMS).contents.rgrc[0] if msg.wParam else cast(msg.lParam, LPRECT).contents
                if position == taskbar.LEFT:
                    rect.top -= taskbar.AUTO_HIDE_THICKNESS
                    rect.left += taskbar.AUTO_HIDE_THICKNESS
                elif position == taskbar.TOP:
                    rect.top += taskbar.AUTO_HIDE_THICKNESS
        return result


class ThemedMainWindow(_WindowFrame, QMainWindow):
    def __init__(self, parent=None):
        super().__init__(parent)
        self._setup_frame()
        if self.title_bar is not None:
            self.setMenuWidget(self.title_bar)


class ThemedDialog(_WindowFrame, QDialog):
    def __init__(self, parent=None):
        super().__init__(parent)
        self._setup_frame(dialog=True)
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(0)
        if self.title_bar is not None:
            outer.addWidget(self.title_bar)
        body = QWidget(self)
        self.body_layout = QVBoxLayout(body)
        outer.addWidget(body, 1)
