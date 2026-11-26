"""Native drawing for the character portraits, role editor and settings."""
from pathlib import Path
from PyQt6.QtCore import QRectF, QSize, Qt
from PyQt6.QtGui import QColor, QLinearGradient, QPainter, QPainterPath, QPen, QPixmap
from PyQt6.QtWidgets import QCheckBox, QLabel, QSizePolicy, QStyledItemDelegate, QToolButton, QVBoxLayout, QWidget
from .themes import colors


class SidebarToggle(QToolButton):
    def __init__(self, action):
        super().__init__()
        self.setObjectName('sidebarToggle')
        self.setDefaultAction(action)
        self.setAccessibleName(action.text())
        action.changed.connect(self._update_action_name)
        self.setAutoRaise(True)
        self.setFocusPolicy(Qt.FocusPolicy.TabFocus)
        self.setFixedSize(32,32)
        self.setIconSize(QSize(19,19))

    def _update_action_name(self):
        self.setAccessibleName(self.defaultAction().text())


class SidebarTitleDelegate(QStyledItemDelegate):
    unread_role = Qt.ItemDataRole.UserRole + 1

    def sizeHint(self, option, index):
        size = super().sizeHint(option, index)
        # The viewport supplies the row width. Keep Qt's styled row height.
        size.setWidth(0)
        return size

    def initStyleOption(self, option, index):
        super().initStyleOption(option, index)
        if index.data(self.unread_role):
            # Keep the trailing unread indicator visible even for long titles.
            option.textElideMode = Qt.TextElideMode.ElideMiddle


class Portrait(QWidget):
    def __init__(self,file,diameter,parent=None):
        super().__init__(parent)
        self.set_image(file)
        self.setFixedSize(diameter,diameter)

    def set_image(self,file):
        self.image=QPixmap(str(file)) if file and Path(file).is_file() else QPixmap()
        self.update()

    def paintEvent(self,event):
        p=QPainter(self)
        p.setRenderHints(QPainter.RenderHint.Antialiasing|QPainter.RenderHint.SmoothPixmapTransform)
        rect=QRectF(self.rect()).adjusted(1,1,-1,-1)
        clip=QPainterPath()
        clip.addEllipse(rect)
        p.setClipPath(clip)
        p.fillRect(rect,QColor(colors()['selection']))
        if not self.image.isNull():
            size=min(self.image.width(),self.image.height())
            p.drawPixmap(rect,self.image,QRectF((self.image.width()-size)/2,(self.image.height()-size)/2,size,size))
        p.end()


class RoleBanner(QWidget):
    def __init__(self,file,parent=None):
        super().__init__(parent)
        self.image=QPixmap(str(file))
        self.setFixedHeight(82)
        content=QVBoxLayout(self)
        content.setContentsMargins(19,10,16,10)
        content.setSpacing(2)
        content.addStretch()
        name=QLabel('式波 · 明日香')
        name.setObjectName('profileName')
        content.addWidget(name)
        original=QLabel('式波・アスカ・ラングレー')
        original.setObjectName('profileNameJa')
        content.addWidget(original)
        content.addStretch()

    def paintEvent(self,event):
        p=QPainter(self)
        p.setRenderHints(QPainter.RenderHint.SmoothPixmapTransform|QPainter.RenderHint.Antialiasing)
        rect=QRectF(self.rect())
        clip=QPainterPath()
        clip.addRoundedRect(rect,10,10)
        p.setClipPath(clip)
        tone=QColor(colors()['banner'])
        p.fillRect(rect,tone)
        if not self.image.isNull():
            scale=max(self.width()/self.image.width(),.32)
            width,height=self.image.width()*scale,self.image.height()*scale
            dest=QRectF(self.width()*.72-width*.63,self.height()*.48-height*.205,width,height)
            p.drawPixmap(dest,self.image,QRectF(self.image.rect()))
            fade=QLinearGradient(0,0,self.width(),0)
            for point,alpha in ((0,255),(.26,246),(.50,155),(.71,25),(1,83)):
                shade=QColor(tone)
                shade.setAlpha(alpha)
                fade.setColorAt(point,shade)
            p.fillRect(rect,fade)
        p.end()


class SettingsSwitch(QCheckBox):
    """A standard keyboard-accessible checkbox with a right-aligned switch."""
    def __init__(self,text,parent=None):
        super().__init__(text,parent)
        self.setSizePolicy(QSizePolicy.Policy.Expanding,QSizePolicy.Policy.Fixed)
        self.setMinimumHeight(34)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)

    def sizeHint(self):
        return QSize(self.fontMetrics().horizontalAdvance(self.text())+62,max(34,self.fontMetrics().height()+10))

    def hitButton(self,pos):
        return self.rect().contains(pos)

    def paintEvent(self,event):
        c=colors()
        p=QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        text_bounds=QRectF(1,0,max(0,self.width()-55),self.height())
        p.setPen(QColor(c['text'] if self.isEnabled() else c['disabled']))
        label=self.fontMetrics().elidedText(self.text(),Qt.TextElideMode.ElideRight,int(text_bounds.width()))
        p.drawText(text_bounds,Qt.AlignmentFlag.AlignVCenter|Qt.AlignmentFlag.AlignLeft,label)
        track=QRectF(self.width()-39,(self.height()-20)/2,36,20)
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(QColor((c['control'] if self.isChecked() else c['switch_off']) if self.isEnabled() else c['field']))
        p.drawRoundedRect(track,10,10)
        p.setBrush(QColor(c['on_control'] if self.isChecked() else c['muted']))
        p.drawEllipse(QRectF(track.x()+(19 if self.isChecked() else 3),track.y()+3,14,14))
        if self.hasFocus() and self.window().testAttribute(Qt.WidgetAttribute.WA_KeyboardFocusChange):
            p.setPen(QPen(QColor(c['accent']),1))
            p.setBrush(Qt.BrushStyle.NoBrush)
            p.drawRoundedRect(track.adjusted(-2,-2,2,2),12,12)
        p.end()
