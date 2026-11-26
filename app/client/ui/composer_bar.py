"""Compact composer surface; existing chat, settings and audio own behavior."""
from .themes import set_theme_style, style_color, colors
from PyQt6.QtCore import Qt, QRectF, QPointF, QSize
from PyQt6.QtGui import QColor, QIcon, QPainter, QPen, QPixmap, QPolygonF, QPainterPath
from PyQt6.QtWidgets import QFrame, QHBoxLayout, QVBoxLayout, QPushButton


def composer_icon(kind, color='#dadfe7'):
    image=QPixmap(48,48); image.setDevicePixelRatio(2.0); image.fill(Qt.GlobalColor.transparent)
    p=QPainter(image); p.setRenderHint(QPainter.RenderHint.Antialiasing)
    p.setPen(QPen(QColor(color),1.7,Qt.PenStyle.SolidLine,Qt.PenCapStyle.RoundCap,Qt.PenJoinStyle.RoundJoin))
    p.setBrush(Qt.BrushStyle.NoBrush)
    if kind=='plus':
        p.drawLine(QPointF(12,5),QPointF(12,19));p.drawLine(QPointF(5,12),QPointF(19,12))
    elif kind in ('sidebar-hide','sidebar-show'):
        p.drawRoundedRect(QRectF(2.5,4,19,16),2.5,2.5)
        p.drawLine(QPointF(8.5,4),QPointF(8.5,20))
        outer,tip = (16,12.5) if kind=='sidebar-hide' else (12.5,16)
        p.drawPolyline(QPolygonF([QPointF(outer,8.5),QPointF(tip,12),QPointF(outer,15.5)]))
    elif kind=='search':
        p.drawEllipse(QRectF(4,4,12,12));p.drawLine(QPointF(14.5,14.5),QPointF(21,21))
    elif kind=='chat':
        path=QPainterPath(QPointF(5,4));path.lineTo(19,4);path.quadTo(21,4,21,6);path.lineTo(21,15)
        path.quadTo(21,17,19,17);path.lineTo(10,17);path.lineTo(5,21);path.lineTo(5,17);path.quadTo(3,17,3,15)
        path.lineTo(3,6);path.quadTo(3,4,5,4);p.drawPath(path)
    elif kind=='settings':
        for y,x in ((6,9),(12,16),(18,7)):
            p.drawLine(QPointF(3,y),QPointF(x-2,y));p.drawLine(QPointF(x+2,y),QPointF(21,y));p.drawEllipse(QPointF(x,y),2,2)
    elif kind=='book':
        p.drawRoundedRect(QRectF(5,3,15,18),2,2);p.drawLine(QPointF(8.5,4),QPointF(8.5,20))
        p.drawLine(QPointF(12,8),QPointF(17,8));p.drawLine(QPointF(12,12),QPointF(16,12))
    elif kind=='profile':
        p.drawEllipse(QRectF(8,3,8,8))
        path=QPainterPath(QPointF(4,21));path.quadTo(4,14,12,14);path.quadTo(20,14,20,21);p.drawPath(path)
    elif kind=='service':
        for y in (4,14):
            p.drawRoundedRect(QRectF(3,y,18,6),1.5,1.5);p.drawPoint(QPointF(6.5,y+3))
            p.drawLine(QPointF(11,y+3),QPointF(17,y+3))
    elif kind=='palette':
        p.drawEllipse(QRectF(3,3,18,18))
        p.setBrush(QColor(color));p.drawPie(QRectF(3,3,18,18),90*16,180*16)
    elif kind=='history':
        p.drawEllipse(QRectF(3,3,18,18));p.drawLine(QPointF(12,6),QPointF(12,12));p.drawLine(QPointF(12,12),QPointF(16,14))
    elif kind in {'mic','mic-off'}:
        p.drawRoundedRect(QRectF(9,3,6,12),3,3)
        p.drawArc(QRectF(6,5,12,14),180*16,180*16)
        p.drawLine(QPointF(12,19),QPointF(12,22))
        if kind=='mic-off':p.drawLine(QPointF(4,3),QPointF(20,21))
    elif kind=='wave':
        for x,h in [(5,7),(9,13),(13,18),(17,10),(21,5)]:p.drawLine(QPointF(x,12-h/2),QPointF(x,12+h/2))
    elif kind=='send':
        p.drawLine(QPointF(12,19),QPointF(12,5));p.drawLine(QPointF(6,11),QPointF(12,5));p.drawLine(QPointF(18,11),QPointF(12,5))
    elif kind=='speaker-off':
        p.drawPolygon(QPolygonF([QPointF(3,10),QPointF(7,10),QPointF(12,6),
                                 QPointF(12,18),QPointF(7,14),QPointF(3,14)]))
        p.drawLine(QPointF(16,9),QPointF(21,15))
        p.drawLine(QPointF(21,9),QPointF(16,15))
    elif kind=='stop':
        p.setPen(Qt.PenStyle.NoPen);p.setBrush(QColor(color));p.drawRoundedRect(QRectF(6,6,12,12),2,2)
    elif kind in ('phone','hangup'):
        if kind=='phone':
            p.translate(12,12);p.rotate(138);p.translate(-12,-12)
        path=QPainterPath(QPointF(3,13));path.cubicTo(7,6,17,6,21,13)
        path.lineTo(19,16);path.lineTo(15.5,14.5);path.lineTo(15.5,11.5)
        path.quadTo(12,10.5,8.5,11.5);path.lineTo(8.5,14.5);path.lineTo(5,16);path.closeSubpath()
        p.drawPath(path)
    elif kind in ('chevron-right','chevron-down'):
        points=([(9,5),(16,12),(9,19)] if kind=='chevron-right' else [(5,9),(12,16),(19,9)])
        p.drawPolyline(QPolygonF([QPointF(x,y) for x,y in points]))
    elif kind=='more':
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(QColor(color))
        for x in (5,12,19):p.drawEllipse(QPointF(x,12),1.55,1.55)
    elif kind=='topic':
        for x in (8,16):p.drawLine(QPointF(x+2,4),QPointF(x-1,20))
        for y in (9,15):p.drawLine(QPointF(4,y),QPointF(20,y))
    elif kind=='network':
        points=[QPointF(12,4),QPointF(4,11),QPointF(20,11),QPointF(8,20),QPointF(17,20)]
        for a,b in [(0,1),(0,2),(1,3),(1,4),(2,4),(3,4)]:p.drawLine(points[a],points[b])
        p.setBrush(QColor(colors()['surface']))
        for point in points:p.drawEllipse(point,2.4,2.4)
    elif kind=='shield':
        p.drawPolygon(QPolygonF([QPointF(12,3),QPointF(20,7),QPointF(18,16),QPointF(12,21),QPointF(6,16),QPointF(4,7)]))
        p.drawLine(QPointF(9,12),QPointF(11,14));p.drawLine(QPointF(11,14),QPointF(16,9))
    p.end();return QIcon(image)


class ContextIndicator(QPushButton):
    def __init__(self,parent=None):
        super().__init__(parent)
        self.setFixedSize(28,32)
        self.setObjectName('contextIndicator')
        self.setAccessibleName('上下文窗口')
        self._ratio=None
        self.set_usage(None)

    def set_usage(self,data):
        main=(data or {}).get('main') or {}
        value=main.get('ratio')
        self._ratio=float(value) if isinstance(value,(int,float)) and value>=0 else None
        lines=['上下文窗口']
        if data and data.get('source')=='general-last-request':
            lines.append('上次聊天请求；显示已记录阶段中占用较高的一项。')
        elif data and data.get('source')=='pi-current-estimate':lines.append('当前会话估算；根据最近响应及后续消息计算。')
        if self._ratio is None:
            lines.append('有阶段尚无可靠用量' if (data or {}).get('unknown_phases') else '当前模式/模型尚无可用统计')
            if (data or {}).get('context_window'):
                lines.append(f"窗口容量：{data['context_window']:,} tokens")
        labels={'analysis':'深度分析','analysis-fast':'快速分析','analysis-auto':'自动分析','reply':'回复','light':'对话'}
        for phase in (data or {}).get('phases',[]):
            lines.append(f"{labels.get(phase['phase'],phase['phase'])}：{phase['tokens']:,} / {phase['context_window']:,} tokens（{phase['ratio']:.1%}）")
        history=(data or {}).get('history',{})
        if (data or {}).get('automatic_depth'):
            lines.append('本轮采用：'+('快速' if data['automatic_depth']=='fast' else '深度')+('（已转深度）' if data.get('automatic_fallback') else '（模型选择）'))
        if data and data.get('source')=='general-last-request':
            if history.get('shared_dialogue_context'):
                lines.append('共用当前会话上下文＋人格记忆检索。')
                if history.get('inherited_summary'):lines.append('包含会话已有摘要；未额外生成摘要。')
            else:
                recent=history.get('recent_turns')
                lines.append((f'最近 {recent} 轮＋记忆检索；' if recent is not None else '近期对话＋记忆检索；')+'不是自动摘要压缩。')
        elif history.get('auto_summary') is True:lines.append('自动摘要压缩：已启用')
        elif data and 'auto_summary' in history:lines.append('自动摘要压缩：未启用')
        if data and data.get('compacting'):lines.append('正在压缩上下文…')
        lines.append('上下文占用与缓存命中率不同。')
        self.setToolTip('\n'.join(lines));self.update()

    def paintEvent(self,event):
        p=QPainter(self);p.setRenderHint(QPainter.RenderHint.Antialiasing)
        rect=QRectF(7,9,14,14)
        p.setPen(QPen(QColor(style_color('#555963')),2.5));p.setBrush(Qt.BrushStyle.NoBrush);p.drawEllipse(rect)
        if self._ratio is not None:
            color='#e7b56a' if self._ratio>.8 else colors()['muted']
            p.setPen(QPen(QColor(color),2.5,Qt.PenStyle.SolidLine,Qt.PenCapStyle.RoundCap))
            p.drawArc(rect,90*16,-round(min(1,self._ratio)*360*16))
        p.end()


class MenuButton(QPushButton):
    def paintEvent(self,event):
        super().paintEvent(event)
        p=QPainter(self);p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.setPen(QPen(QColor(style_color('#9ea6b3')),1.3,Qt.PenStyle.SolidLine,Qt.PenCapStyle.RoundCap))
        x,y=self.width()-10,self.height()/2
        p.drawLine(QPointF(x-3,y-1.5),QPointF(x,y+1.5));p.drawLine(QPointF(x,y+1.5),QPointF(x+3,y-1.5));p.end()


class ComposerSurface(QFrame):
    def __init__(self,editor,attach,label,remove,permission,context,mic,send,cancel,parent=None):
        super().__init__(parent)
        self.permission_button = permission
        self._permission_label = permission.text()
        self.setObjectName('composerSurface')
        set_theme_style(self,lambda c: f'''
          QFrame#composerSurface {{background:{c['card']};border:1px solid {c['border']};border-radius:17px;}}
          QPlainTextEdit#messageComposer {{background:transparent;border:0;color:{c['text']};padding:3px 1px;selection-background-color:{c['selection']};}}
          QPushButton {{background:transparent;border:0;color:{c['muted']};padding:4px 7px;border-radius:9px;}}
          QPushButton:hover {{background:{c['selection']};color:{c['text']};}}
          QPushButton:disabled {{color:{c['disabled']};}}
          QPushButton#composerPermission {{padding-right:22px;}}
          QPushButton#composerSend {{background:{c['brand']};border-radius:17px;}}
          QPushButton#composerCancel {{background:{c['switch_off']};border-radius:19px;}}
          QPushButton#composerMic[recording="true"] {{background:#8b3d50;}}
        ''')
        layout=QVBoxLayout(self);layout.setContentsMargins(14,10,12,9);layout.setSpacing(3)
        layout.addWidget(editor)
        attachments=QHBoxLayout();attachments.setContentsMargins(0,0,0,0)
        attachments.addWidget(label);attachments.addWidget(remove);attachments.addStretch();layout.addLayout(attachments)
        row=QHBoxLayout();row.setContentsMargins(0,0,0,0);row.setSpacing(4)
        for button,kind,name in [(attach,'plus','composerAttach'),(permission,'shield','composerPermission'),
                                 (mic,'mic','composerMic'),(send,'send','composerSend'),(cancel,'stop','composerCancel')]:
            button.setObjectName(name);button.setIcon(composer_icon(kind));button.setIconSize(QSize(22,22))
            if button is not permission:
                button.setText('');button.setFixedSize(38 if button in (send,cancel) else 34,38)
        row.addWidget(attach);row.addWidget(permission);row.addStretch()
        row.addWidget(context);row.addSpacing(4);row.addWidget(mic);row.addWidget(send);row.addWidget(cancel)
        layout.addLayout(row)

    def set_permission_label(self, label):
        self._permission_label = label
        self.permission_button.setAccessibleName(label)
        self._fit_toolbar()

    def _fit_toolbar(self):
        self.permission_button.setText(self._permission_label if self.width() >= 440 else '')

    def resizeEvent(self, event):
        super().resizeEvent(event)
        self._fit_toolbar()
