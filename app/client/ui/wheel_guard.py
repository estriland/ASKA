"""Keep wheel scrolling from changing settings or tabs accidentally."""
from PyQt6.QtCore import QEvent, QObject, QPointF
from PyQt6.QtGui import QWheelEvent
from PyQt6.QtWidgets import (
    QApplication, QWidget, QAbstractScrollArea, QAbstractSpinBox,
    QComboBox, QSlider, QTabBar,
)


class WheelGuard(QObject):
    """Route wheel events over value controls to their containing scroll area.

    Mouse clicks and keyboard input remain native. An open combo's list view
    keeps its normal scrolling; a closed combo never changes via the wheel.
    """

    def __init__(self, root):
        super().__init__(root)
        self.root = root
        QApplication.instance().installEventFilter(self)

    def eventFilter(self, watched, event):
        if (event.type() != QEvent.Type.Wheel
                or not isinstance(watched, QWidget)
                or not self.root.isAncestorOf(watched)):
            return False
        control = watched
        if isinstance(watched.parentWidget(), QAbstractSpinBox):
            control = watched.parentWidget()
        if not isinstance(control, (QComboBox, QAbstractSpinBox, QSlider, QTabBar)):
            return False
        parent = control.parentWidget()
        while parent is not None and parent is not self.root:
            if isinstance(parent, QAbstractScrollArea):
                viewport = parent.viewport()
                forwarded = QWheelEvent(
                    QPointF(viewport.mapFromGlobal(event.globalPosition().toPoint())),
                    event.globalPosition(), event.pixelDelta(), event.angleDelta(),
                    event.buttons(), event.modifiers(), event.phase(), event.inverted(),
                )
                QApplication.sendEvent(viewport, forwarded)
                break
            parent = parent.parentWidget()
        event.accept()
        return True
