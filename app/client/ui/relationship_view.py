"""Qt navigation for one relationship, its topic groups and voice calls."""
from collections import deque
from datetime import datetime
import json
import threading
import time

from PyQt6 import sip
from PyQt6.QtCore import QObject, QPoint, QSize, QThread, QTimer, Qt
from PyQt6.QtGui import QKeySequence, QShortcut
from PyQt6.QtWidgets import (QComboBox, QDialog, QDialogButtonBox, QFrame, QHBoxLayout, QInputDialog,
                             QLabel, QLineEdit, QListWidget, QListWidgetItem, QMenu, QMessageBox,
                             QPushButton, QSizePolicy, QStyle, QTabBar, QTextBrowser, QVBoxLayout, QWidget)

from ui.widgets import ChatMessageRow, ChatScrollArea
from ui.composer_bar import composer_icon
from ui.appearance import Portrait, SidebarTitleDelegate


class ConversationTitle(QLabel):
    def __init__(self):
        super().__init__()
        self.full_title=''
        self.setObjectName('conversationTitle')
        self.setTextFormat(Qt.TextFormat.PlainText)
        self.setSizePolicy(QSizePolicy.Policy.Preferred,QSizePolicy.Policy.Preferred)
        self.setMinimumWidth(0)
        self.set_title('全部消息')

    def set_title(self, title):
        self.full_title=title
        self.setToolTip(title)
        self.setAccessibleName(title)
        self.updateGeometry()
        self._elide()

    def sizeHint(self):
        size=super().sizeHint()
        size.setWidth(min(self.fontMetrics().horizontalAdvance(self.full_title)+6,self.fontMetrics().height()*15))
        return size

    def minimumSizeHint(self):
        return QSize(0,super().minimumSizeHint().height())

    def _elide(self):
        self.setText(self.fontMetrics().elidedText(self.full_title,Qt.TextElideMode.ElideRight,max(1,self.width()-4)))

    def resizeEvent(self, event):
        super().resizeEvent(event)
        self._elide()


def timestamp(value, fmt='%m月%d日 %H:%M'):
    try:
        return datetime.fromtimestamp(value / 1000).strftime(fmt)
    except (TypeError, ValueError, OSError, OverflowError):
        return ''


class CallHistoryReceipt(threading.Event):
    def __init__(self, request_id):
        super().__init__()
        self.request_id = request_id
        self.rejected = False
        self.events = []
        self.unconfirmed = set()


class RelationshipRequest(QThread):
    def __init__(self, brain, method, route, body, parent):
        super().__init__(parent)
        self.brain, self.method, self.route, self.body = brain, method, route, body
        self.result = {}

    def run(self):
        try:
            self.result = self.brain.request(self.method, self.route, self.body, timeout=12)
        except (OSError, ValueError, RuntimeError) as error:
            self.result = {'ok': False, 'error': str(error)}


class CallCard(QFrame):
    def __init__(self, view, data):
        super().__init__()
        self.view, self.data = view, data
        self.loaded = self.loading = False
        self.cursor = None
        self.setObjectName('relationshipCall')
        layout = QVBoxLayout(self)
        self.toggle = QPushButton()
        self.toggle.setObjectName('callHistoryToggle')
        self.toggle.setCheckable(True)
        self.toggle.toggled.connect(self.expand)
        layout.addWidget(self.toggle)
        self.body = QWidget()
        self.lines = QVBoxLayout(self.body)
        self.lines.setContentsMargins(0, 0, 0, 0)
        self.older = QPushButton('更早的通话内容')
        self.older.clicked.connect(self.load)
        self.lines.addWidget(self.older)
        self.older.hide()
        layout.addWidget(self.body)
        self.body.hide()
        self.expand(False)

    def expand(self, enabled):
        end = self.data.get('ended_at')
        start = self.data.get('started_at')
        span = timestamp(start, '%m月%d日 %H:%M:%S')
        end_format = '%H:%M:%S' if timestamp(start,'%Y-%m-%d')==timestamp(end,'%Y-%m-%d') else '%m月%d日 %H:%M:%S'
        state = '进行中' if self.view.w._active_call_id == self.data['call_id'] else '结束时间未记录'
        span += ' – ' + (timestamp(end,end_format) if end else state)
        self.toggle.setIcon(self.style().standardIcon(QStyle.StandardPixmap.SP_ArrowDown if enabled else QStyle.StandardPixmap.SP_ArrowRight))
        self.toggle.setAccessibleName('收起通话记录' if enabled else '展开通话记录')
        self.toggle.setText(f'语音通话　{span}　·　{self.data.get("count",0)} 轮')
        self.body.setVisible(enabled)
        if enabled and not self.loaded:
            self.load()

    def load(self):
        if self.loading: return
        self.loading = True
        self.older.setEnabled(False)
        body = {'call_id': self.data['call_id'], 'limit': 30}
        if self.cursor: body['before'] = self.cursor
        self.view.request('POST', '/relationship/history', body, self.receive)

    def receive(self, data):
        if sip.isdeleted(self): return
        self.loading = False
        self.older.setEnabled(True)
        if not data.get('ok'):
            self.older.setText('重新读取通话')
            self.older.show()
            return
        insert_at = 1
        for message in data['messages']:
            user = message.get('role') == 'user'
            text = message.get('speech') or message.get('content', '')
            if not text: continue
            translation = message.get('translation')
            row = ChatMessageRow(text, is_user=user, avatar_path=self.view.w._asuka_avatar,
                                 translation=translation if translation != text else None, parts=message.get('parts'),
                                 call_subtitles=True)
            row.request_id = message.get('request_id')
            self.view.attach_row(row)
            if not user:
                self.view.w._bind_replay_row(row, message.get('playback_id'))
            self.lines.insertWidget(insert_at, row)
            insert_at += 1
            boundary = message.get('playback_boundary')
            if isinstance(boundary,dict):
                ms = boundary.get('played_ms',0)
                heard = boundary.get('heard_prefix') or ''
                reason = {'user_speech':'用户插话','hangup':'挂断','stop_audio':'停止音频','exit':'退出'}.get(boundary.get('reason'),'停播')
                note = f'{reason} · 设备播放 {ms/1000:.2f} 秒' if ms else f'{reason} · 尚未出声'
                if heard: note += '　估算播至「'+heard+'」'
                marker = QLabel(note)
                marker.setTextFormat(Qt.TextFormat.PlainText)
                marker.setWordWrap(True)
                marker.setObjectName('mutedLabel')
                self.lines.insertWidget(insert_at,marker)
                insert_at += 1
        if not data['messages'] and not self.loaded:
            self.lines.addWidget(QLabel('本次通话没有对话内容。'))
        self.loaded = True
        self.cursor = data.get('more')
        self.older.setText('更早的通话内容')
        self.older.setVisible(bool(self.cursor))


class RelationshipView(QObject):
    def __init__(self, window, sidebar, heading):
        super().__init__(window)
        self.w = window
        self.ready = self.erasing = False
        self.generation = self.list_generation = 0
        self.groups = []
        self.unread = set()
        self.draft_files = {}
        self.shown = window.chat_display
        self.retired = []
        self.cursor = None
        self.loading_older = False
        self.needs_refresh = False
        self.refresh_timer = QTimer(self)
        self.refresh_timer.setSingleShot(True)
        self.refresh_timer.timeout.connect(self.refresh_pending)
        self.call_writing = False
        self.call_retry_ms = 800
        self.call_waiting = deque()
        self.call_barriers = []
        self.call_retry = QTimer(self)
        self.call_retry.setSingleShot(True)
        self.call_retry.timeout.connect(self.flush_call_events)
        self.retire_timer = QTimer(self)
        self.retire_timer.setSingleShot(True)
        self.retire_timer.timeout.connect(self.discard_retired)
        window.new_conv_btn.setText('')
        window.new_conv_btn.setFixedSize(28,28)
        window.session_list.setIconSize(QSize(16,16))
        window.new_conv_btn.setObjectName('groupCreate')
        window.new_conv_btn.setIcon(composer_icon('plus'))
        window.new_conv_btn.setIconSize(QSize(15,15))
        window.new_conv_btn.setAccessibleName('新分组')
        chat_page=window.page_stack.widget(0)
        QShortcut(QKeySequence.StandardKey.New,chat_page).activated.connect(window.new_conv_btn.click)
        window.new_conv_btn.setToolTip('新分组 (Ctrl+N)')
        window.new_conv_btn.setEnabled(False)
        heading.setText('消息分组')
        section = QHBoxLayout()
        sidebar.removeWidget(heading)
        sidebar.removeWidget(window.new_conv_btn)
        section.addWidget(heading,1)
        section.addWidget(window.new_conv_btn)
        self.search_button = QPushButton('搜索消息与纪要')
        self.search_button.setObjectName('sidebarSearch')
        self.search_button.setIcon(composer_icon('search'))
        self.search_button.setIconSize(QSize(17,17))
        QShortcut(QKeySequence.StandardKey.Find,chat_page).activated.connect(self.search_button.click)
        self.search_button.setToolTip('搜索当前范围的消息与纪要 (Ctrl+F)')
        self.search_button.setEnabled(False)
        self.search_button.clicked.connect(lambda:self.search())
        sidebar.insertWidget(0,self.search_button)
        sidebar.insertLayout(1,section)
        self.records=QPushButton('记录')
        self.records.setObjectName('sidebarRecords')
        self.records.setIcon(composer_icon('book'))
        self.records.setAccessibleName('记录：事件日志与导出')
        self.records.setToolTip('事件日志与聊天导出')
        record_menu=QMenu(self.records)
        record_menu.aboutToShow.connect(lambda:record_menu.setProperty('groupId',window._relationship_group_id))
        record_menu.addAction('事件日志…',lambda:self.journal(record_menu.property('groupId')))
        record_menu.addAction('导出全部文字聊天…',window.export_conversation)
        self.records.setMenu(record_menu)
        self.records.setEnabled(False)
        sidebar.addWidget(self.records)
        self.scope_title=ConversationTitle()
        self.header_avatar=Portrait(window._asuka_avatar,38)
        window.chat_header.insertWidget(0,self.header_avatar)
        identity=QWidget()
        identity_box=QVBoxLayout(identity)
        identity_box.setContentsMargins(0,0,0,0)
        identity_box.setSpacing(1)
        name=QLabel('明日香' if not self.header_avatar.image.isNull() else '对话')
        name.setObjectName('conversationName')
        identity_box.addWidget(name)
        identity_box.addWidget(self.scope_title)
        window.chat_header.insertWidget(1,identity)
        self.manage=QPushButton()
        self.manage.setObjectName('groupActions')
        self.manage.setIcon(composer_icon('more'))
        self.manage.setFixedSize(30,28)
        self.manage.setAccessibleName('当前分组操作')
        self.manage.setToolTip('重命名或移除当前分组')
        self.group_actions=QMenu(self.manage)
        self.group_actions.aboutToShow.connect(lambda:self.group_actions.setProperty('groupId',window._relationship_group_id))
        self.group_actions.addAction('重命名分组…',lambda:self.edit_group('rename',self.group_actions.property('groupId')))
        self.group_actions.addAction('移除分组…',lambda:self.edit_group('remove',self.group_actions.property('groupId')))
        self.manage.setMenu(self.group_actions)
        window.chat_header.insertWidget(2,self.manage)
        self.manage.hide()
        self.older = QPushButton('更早的消息')
        self.older.setObjectName('historyEarlier')
        self.older.clicked.connect(self.load_older)
        window.chat_header.insertWidget(3,self.older)
        self.older.hide()
        self.rename_shortcut=QShortcut(QKeySequence('F2'),window.session_list)
        self.rename_shortcut.setContext(Qt.ShortcutContext.WidgetShortcut)
        self.rename_shortcut.activated.connect(lambda:self.edit_group('rename',window._relationship_group_id)
                                              if window._relationship_group_id else None)
        for key in (QKeySequence('Shift+F10'),QKeySequence(Qt.Key.Key_Menu)):
            shortcut=QShortcut(key,window.session_list)
            shortcut.setContext(Qt.ShortcutContext.WidgetShortcut)
            shortcut.activated.connect(lambda:self.group_menu(QPoint(-1,-1)))
        self.shown.group_id = None
        window.session_list.currentItemChanged.connect(self._selected_item_changed)

    def accepts(self, packet):
        key = getattr(self.w.chat_display,'group_id',None)
        return key is None or key == packet.get('group_id')

    def request(self, method, route, body, callback, *, during_close=False):
        sid = (self.w._current_session or {}).get('id')
        if body is not None and sid:
            body = {'relationship_id':sid, **body}
        worker = RelationshipRequest(self.w.manager.brain, method, route, body, self.w)
        self.w._list_workers.add(worker)
        def done():
            self.w._list_workers.discard(worker)
            if during_close or not self.w._closing:
                callback(worker.result)
            worker.deleteLater()
        worker.finished.connect(done)
        worker.start()

    def list_groups(self, *, startup=False, selected=None, choose=False):
        self.list_generation += 1
        version = self.list_generation
        def receive(data):
            if version != self.list_generation: return
            if not data.get('ok') or not data.get('id'):
                self.shown.show_system_notice('分组暂时无法读取。',on_retry=lambda:self.list_groups(startup=startup))
                return
            w = self.w
            self.groups = data.get('groups', [])
            w._current_session = {'id':data['id'], 'path':data.get('path'), 'title':'全部消息',
                                  'empty_session':not data.get('path')}
            w._pending_session_id = None
            w._sessions = [w._current_session]
            if startup:
                self.unread = set(self._saved('unread_groups'))
            known = {None, *(group['id'] for group in self.groups)}
            if self.unread - known:
                self.unread.intersection_update(known)
                self.unread.add(None)
                self._save('unread_groups',list(self.unread))
            self.clean_replays(data.get('replay_cleanup',[]))
            key = selected if choose else w._relationship_group_id
            if startup:
                key = w._settings.value('relationship/selected_group', '') or None
            if key not in {g['id'] for g in self.groups}: key = None
            self.draw_list(key)
            if startup or choose or key != w._relationship_group_id:
                self.select(key, startup=startup, force=True)
        self.request('GET', '/relationship', None, receive)

    def draw_list(self, key):
        listing = self.w.session_list
        title=next((group['title'] for group in self.groups if group['id']==key),'全部消息')
        self.scope_title.set_title(title)
        self.manage.setVisible(key is not None)
        self.records.setEnabled(self.ready)
        self.w.chat_nav_btn.setText('对话　• 新消息' if self.unread else '对话')
        listing.blockSignals(True)
        try:
            listing.clear()
            for group in [{'id': None, 'title':'全部消息'}, *self.groups]:
                gid = group['id']
                item = QListWidgetItem(group['title'] + ('　• 新消息' if gid in self.unread else ''))
                item.setToolTip(group['title'])
                item.setData(SidebarTitleDelegate.unread_role, gid in self.unread)
                item.setIcon(composer_icon('topic' if gid else 'chat'))
                item.setData(Qt.ItemDataRole.UserRole, gid)
                listing.addItem(item)
                if gid == key: listing.setCurrentItem(item)
        finally: listing.blockSignals(False)

    def _selected_item_changed(self, item, _old):
        if item is not None and self.ready:
            self.select(item.data(Qt.ItemDataRole.UserRole))

    def _new_display(self, key):
        w = self.w
        area = ChatScrollArea(chat_bubbles=self.shown._chat_bubbles)
        area.group_id = key
        area.set_background(w._chat_bg)
        area.set_background_opacity(w._background_opacity / 100.)
        for widget in (area, area.viewport()):
            widget.setAcceptDrops(True)
            widget.installEventFilter(w)
        area.viewport().installEventFilter(w.chat_surface)
        w.chat_surface.layout().addWidget(area)
        return area

    def _show(self, area):
        if self.shown is area: return
        old = self.shown
        old.hide()
        if old not in self.retired: self.retired.append(old)
        if area in self.retired: self.retired.remove(area)
        self.shown = area
        self.w.chat_surface.chat = area
        area.show()
        self.w.chat_surface.schedule_layout()

    def discard_retired(self):
        w = self.w
        rows = [w._active_tts_row]
        if getattr(w,'_pending_tts',False): rows.append(w._pending_tts_row)
        if w._chat_busy: rows.append(w._chat_user_row)
        rows += [entry.get('row') for entry in w._tts_queue]
        for area in self.retired[:]:
            if area is w.chat_display or any(r is not None and not sip.isdeleted(r) and area.isAncestorOf(r) for r in rows):
                continue
            self.retired.remove(area)
            w.chat_surface.layout().removeWidget(area)
            area.deleteLater()
        if self.retired and not self.w._closing:
            self.retire_timer.start(800)

    def select(self, key, *, startup=False, force=False):
        w = self.w
        if w._closing: return
        if self.erasing:
            self.draw_list(w._relationship_group_id)
            return
        different = key != w._relationship_group_id
        if different and getattr(w,'immediate_followup',None): w.immediate_followup.cancel('group_changed')
        if not different and not force:
            w._switch_page(0)
            if key in self.unread:
                self.unread.remove(key)
                self._save('unread_groups',list(self.unread))
                self.draw_list(key)
            return
        if different and not startup:
            w._save_draft()
            w.dictation.cancel()
            self.draft_files[w._relationship_group_id] = list(w._pending_files)
            w._clear_chat_image()
        w._relationship_group_id = key
        w._settings.setValue('relationship/selected_group', key or '')
        if key in self.unread:
            self.unread.remove(key)
            self._save('unread_groups',list(self.unread))
        self.draw_list(key)
        if different and not startup:
            w._restore_draft()
            w._pending_files = self.draft_files.pop(key,[])
            w._refresh_file_label()
        self.generation += 1
        version = self.generation
        self.cursor = None
        self.older.hide()
        self.loading_older = False
        if different: w._switch_page(0)
        # The original widgets receive their own queued Qt signals until the
        # in-flight reply ends. Browsing creates a separate selected transcript.
        if w._chat_busy and getattr(w.chat_display, 'group_id', None) == key and not startup:
            self._show(w.chat_display)
            w._navigation_blocked = False
            w._update_composer_actions()
            return
        area = self._new_display(key)
        self._show(area)
        if not w._chat_busy: w.chat_display = area
        w._navigation_blocked = True
        w._update_composer_actions()
        area.show_system_notice('正在读取消息…')
        def receive(data):
            if self.erasing or version != self.generation or self.shown is not area: return
            if not data.get('ok') or data.get('id') != (w._current_session or {}).get('id'):
                if key and data.get('code')=='RELATIONSHIP_INPUT' and '分组不存在' in str(data.get('error','')):
                    w.append_status('分组已移除，可在全部消息查看原话。')
                    self.list_groups(selected=None,choose=True)
                    return
                area.show_system_notice('消息暂时无法读取。',on_retry=lambda:self.select(key,startup=startup,force=True))
                return
            with area.batch_update():
                area.clear()
                last_user = None
                for message in data.get('messages', []):
                    row = self.draw_message(area, message)
                    if isinstance(row, ChatMessageRow) and row.is_user: last_user = row
                if not w._chat_busy and w.chat_display is area:
                    w._restore_pending(data.get('pending'),last_user,set(data.get('completed_requests', [])))
            self.cursor = data.get('more')
            self.older.setVisible(bool(self.cursor))
            w._navigation_blocked = False
            first_page = not self.ready
            self.ready = True
            w.new_conv_btn.setEnabled(True)
            self.records.setEnabled(True)
            self.search_button.setEnabled(True)
            w._sync_composer_labels()
            if startup or first_page:
                w._restore_draft()
                self.flush_call_events()
                if getattr(w,'immediate_followup',None): w.immediate_followup.recover_pending()
                self.resume_erasure()
                w._resume_after_startup(True)
            self.discard_retired()
            self.refresh_pending()
        self.request('POST','/relationship/history',{'group_id':key,'limit':40},receive)

    def draw_message(self, area, message, before=None):
        if message.get('role') == 'call':
            card = CallCard(self,message)
            index = area._layout.indexOf(before) if before is not None else area._layout.count()-1
            area._layout.insertWidget(max(0,index),card)
            return card
        if message.get('role') == 'assistant':
            rid = message.get('request_id')
            w = self.w
            if (w._chat_busy and area is not w.chat_display
                    and rid == getattr(getattr(w,'_chat_thread',None),'request_id',None)):
                return None
            row = w._active_tts_row
            if (row is not None and not sip.isdeleted(row) and row._voice_reveal
                    and rid and getattr(row,'request_id',None)==rid and not w._chat_busy):
                area._layout.insertWidget(area._layout.indexOf(before) if before is not None else area._layout.count()-1,row)
                row.show()
                return row
        return self.w._add_history_message(message,before,display=area)

    def attach_row(self, row):
        if getattr(row,'_relationship_menu',False): return
        row._relationship_menu = True
        row.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        def show(point):
            rid = getattr(row,'request_id',None)
            if not rid: return
            menu = QMenu(row)
            menu.addAction('删除这一轮对话…',lambda:self.erase([rid]))
            menu.exec(row.mapToGlobal(point))
        row.customContextMenuRequested.connect(show)

    def load_older(self):
        if self.loading_older or not self.cursor: return
        self.loading_older = True
        area, version = self.shown,self.generation
        def receive(data):
            if self.erasing or version != self.generation or self.shown is not area: return
            self.loading_older = False
            if not data.get('ok'):
                self.w.append_status('更早的消息暂时无法读取，可以重试。')
                return
            first = area._layout.itemAt(0).widget()
            with area.batch_update(follow_latest=False):
                for message in data.get('messages',[]): self.draw_message(area,message,first)
            oldest = area._layout.itemAt(0).widget()
            if oldest: area._prepend_anchor = (oldest, 12)
            area._align_history_anchor()
            area._anchor_timer.start(20)
            self.cursor = data.get('more')
            self.older.setVisible(bool(self.cursor))
        self.request('POST','/relationship/history',{'group_id':self.w._relationship_group_id,'before':self.cursor,'limit':40},receive)

    def finish_turn(self):
        w = self.w
        if self.ready and not (w._current_session or {}).get('path'):
            self.list_groups()
        if self.shown is not w.chat_display:
            packet = getattr(getattr(w,'_chat_thread',None),'request_packet',None) or {}
            origin = packet.get('group_id')
            if origin and origin != w._relationship_group_id:
                self.mark_unread(origin)
            w.chat_display = self.shown
            if w._relationship_group_id is None or w._relationship_group_id == origin:
                self.needs_refresh = True
        self.refresh_pending()
        self.discard_retired()

    def refresh_pending(self):
        w = self.w
        if not self.needs_refresh or w._closing or w._chat_busy or w._navigation_blocked: return
        row = w._active_tts_row
        if row is not None and not sip.isdeleted(row) and self.shown.isAncestorOf(row) and row._voice_reveal:
            self.refresh_timer.start(180)
            return
        self.needs_refresh = False
        self.select(w._relationship_group_id,force=True)

    def arrival(self, group_id, *, notice=None):
        group = next((g for g in self.groups if g['id']==group_id),None)
        target = group['id'] if group else None
        selected = self.w._relationship_group_id
        if notice and not (self.w.session_list.isVisibleTo(self.w) or self.w.chat_nav_btn.isVisibleTo(self.w)):
            return False
        if selected is None or target == selected:
            self.needs_refresh = True
            self.refresh_pending()
        if notice or (selected is not None and target != selected):
            self.mark_unread(target)
        if notice:
            title = group['title'] if group else '全部消息'
            self.w.append_status(f'「{title}」有新的{notice}。')
            return True

    def mark_unread(self, group_id):
        if group_id not in self.unread:
            self.unread.add(group_id)
            self._save('unread_groups',list(self.unread))
        self.draw_list(self.w._relationship_group_id)

    def edit_group(self, action, group_id=None):
        w = self.w
        if self.erasing or not self.ready: return
        body = {'action':action,'group_id':group_id}
        if action in ('create','rename'):
            old = next((g['title'] for g in self.groups if g['id']==group_id),'')
            title,ok = QInputDialog.getText(w,'新分组' if action=='create' else '重命名分组','分组名称',text=old)
            if not ok or not title.strip(): return
            body['title'] = title.strip()
        elif QMessageBox.question(w,'移除分组','移除这个分组？其中的对话仍可在「全部消息」查看。',
                QMessageBox.StandardButton.Yes|QMessageBox.StandardButton.No,QMessageBox.StandardButton.No) != QMessageBox.StandardButton.Yes:
            return
        def receive(data):
            if not data.get('ok'):
                w.append_status('分组操作暂未完成，请重新查看分组。')
                self.list_groups()
                return
            selected = w._relationship_group_id
            if action=='create': selected=(data.get('group') or {}).get('id', data.get('group_id'))
            if action=='remove' and selected==group_id: selected=None
            self.list_groups(selected=selected,choose=action!='rename')
        self.request('POST','/relationship/groups',body,receive)

    def group_menu(self, point):
        item = self.w.session_list.itemAt(point)
        if point.x()<0 or point.y()<0:
            item=self.w.session_list.currentItem()
            if item:point=self.w.session_list.visualItemRect(item).center()
        if item is None: return
        self.w.session_list.setCurrentItem(item)
        gid = item.data(Qt.ItemDataRole.UserRole)
        if gid:
            self.group_actions.exec(self.w.session_list.viewport().mapToGlobal(point))

    def journal(self, group_id):
        dialog = QDialog(self.w)
        dialog.setAttribute(Qt.WidgetAttribute.WA_DeleteOnClose)
        dialog.setWindowTitle('事件日志')
        dialog.resize(560,400)
        layout = QVBoxLayout(dialog)
        body = QTextBrowser()
        body.setPlainText('正在读取…')
        layout.addWidget(body)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Close)
        buttons.rejected.connect(dialog.close)
        layout.addWidget(buttons)
        operations = {'propose':'提出约定','create':'记下安排','accept':'接受约定','confirm':'确认',
                      'reschedule':'改期','cancel':'取消','deliver':'投递','complete':'完成'}
        def receive(data):
            if sip.isdeleted(dialog): return
            if not data.get('ok'):
                body.setPlainText('事件日志暂时无法读取。')
                return
            lines = []
            for event in reversed(data.get('events',[])):
                if group_id and event.get('group_id')!=group_id: continue
                action = operations.get(event.get('operation'),'更新安排')
                line = timestamp(event.get('at'))+'　'+action+'　'+str(event.get('topic') or '')
                if event.get('due_at'):
                    line += '\n约定时间　'+timestamp(event['due_at'])
                lines.append(line)
            body.setPlainText('\n\n'.join(lines) or '这里还没有已记录的安排。')
        dialog.open()
        self.request('POST','/relationship/journal',{'group_id':group_id},receive)

    def search(self, *, summaries=False):
        if not self.ready: return
        dialog = QDialog(self.w)
        dialog.setAttribute(Qt.WidgetAttribute.WA_DeleteOnClose)
        dialog.setWindowModality(Qt.WindowModality.WindowModal)
        dialog.resize(610,510)
        layout = QVBoxLayout(dialog)
        layout.setContentsMargins(16,14,16,14)
        layout.setSpacing(9)
        modes=QTabBar()
        modes.setObjectName('searchModes')
        modes.setAccessibleName('搜索范围')
        modes.setExpanding(False)
        modes.addTab('消息原话')
        modes.addTab('长聊纪要')
        modes.setCurrentIndex(1 if summaries else 0)
        layout.addWidget(modes)
        entry = QLineEdit()
        entry.setAccessibleName('搜索关键词')
        gid = self.w._relationship_group_id
        title = next((g['title'] for g in self.groups if g['id']==gid),'全部消息')
        find = QPushButton('搜索')
        find.setObjectName('primaryButton')
        bar = QHBoxLayout()
        bar.addWidget(entry,1)
        bar.addWidget(find)
        layout.addLayout(bar)
        hits = QListWidget()
        detail = QTextBrowser()
        layout.addWidget(hits)
        layout.addWidget(detail)
        source = QComboBox()
        source.setAccessibleName('原话来源')
        open_turn = QPushButton('查看完整原话')
        origin = QHBoxLayout()
        origin.addWidget(source,1)
        origin.addWidget(open_turn)
        layout.addLayout(origin)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Close)
        buttons.rejected.connect(dialog.close)
        layout.addWidget(buttons)
        version = 0
        def display(item):
            source.clear()
            obj = item.data(Qt.ItemDataRole.UserRole) if item else {}
            kind = obj.get('kind')
            if kind == 'summary':
                detail.setPlainText(obj.get('summary',''))
                ids = obj.get('request_ids',[])
            else:
                detail.setPlainText(self._lines(obj.get('messages',[])))
                ids = [obj.get('request_id')] if obj.get('request_id') else []
            for index,rid in enumerate(ids,1): source.addItem('第 '+str(index)+' 轮原话',rid)
            open_turn.setEnabled(bool(ids))
        def query():
            nonlocal version
            text = entry.text().strip()
            version += 1
            token = version
            hits.clear()
            source.clear()
            open_turn.setEnabled(False)
            if not text and not summaries:
                detail.setPlainText('输入关键词即可查找原话。')
                return
            detail.setPlainText('正在查找…')
            def result(data):
                if sip.isdeleted(dialog) or token != version: return
                if not data.get('ok'):
                    detail.setPlainText('暂时无法查找，请重新搜索。')
                    return
                for kind,values in [('memory',data.get('memories',[])),('summary',data.get('summaries',[]))]:
                    if (kind=='summary') != summaries: continue
                    for obj in values:
                        preview = obj.get('summary') or '　'.join(m.get('text','') for m in obj.get('messages',[]))
                        stamp = timestamp(obj.get('started_at') or obj.get('at'))
                        item = QListWidgetItem(stamp + '　' + ('长聊纪要　' if kind=='summary' else '') + preview[:72])
                        item.setData(Qt.ItemDataRole.UserRole,{**obj,'kind':kind})
                        hits.addItem(item)
                if hits.count(): hits.setCurrentRow(0)
                else: detail.setPlainText('这里还没有相关的长聊纪要。' if summaries else '没有找到相关消息。')
            route = '/relationship/search' if text else '/relationship/journal'
            self.request('POST',route,{'text':text,'group_id':gid},result)
        def original():
            rid = source.currentData()
            if not rid: return
            token=version
            def result(data):
                if sip.isdeleted(dialog) or version!=token or source.currentData()!=rid: return
                lines = data.get('messages',[]) if data.get('ok') else []
                detail.setPlainText(self._lines(lines) or '这条原话暂时无法读取。')
            self.request('POST','/relationship/history',{'group_id':gid,'request_id':rid},result)
        find.clicked.connect(query)
        entry.returnPressed.connect(query)
        hits.currentItemChanged.connect(lambda item,_old:display(item))
        open_turn.clicked.connect(original)
        open_turn.setEnabled(False)
        def select_mode(index):
            nonlocal summaries
            summaries=index==1
            dialog.setWindowTitle('对话纪要' if summaries else '搜索消息与纪要')
            entry.setPlaceholderText('查找「'+title+'」的长聊纪要' if summaries else '查找「'+title+'」的消息原话')
            query()
        modes.currentChanged.connect(select_mode)
        select_mode(modes.currentIndex())
        dialog.open()
        entry.setFocus()

    @staticmethod
    def _lines(messages):
        output = []
        for message in messages:
            who = '你' if message.get('role')=='user' else 'ASKA'
            text = message.get('text') or message.get('speech') or message.get('content','')
            translation = message.get('translation')
            output.append(who+'　'+text+('\n'+translation if translation and translation!=text else ''))
        return '\n\n'.join(output)

    def _saved(self, key):
        try: return json.loads(self.w._settings.value('relationship/'+key,'[]') or '[]')
        except (TypeError,ValueError):return []

    def _save(self, key, values):
        self.w._settings.setValue('relationship/'+key,json.dumps(values,ensure_ascii=False))
        self.w._settings.sync()

    def call_event(self, kind, call_id, details):
        events = self._saved('pending_call_events')
        events.append({'kind':kind,'call_id':call_id,'group_id':self.w._relationship_call_group_id,
                       'occurred_at':round(time.time()*1000),**details})
        self._save('pending_call_events',events)
        self.flush_call_events()

    def defer_call_input(self, text):
        cid = self.w._active_call_id
        if cid and any(event.get('call_id')==cid for event in self._saved('pending_call_events')):
            self.call_waiting.append((cid,text))
            self.flush_call_events()
            return True
        return False

    def pending_call_barrier(self, request_id=None):
        """Freeze only the event prefix which existed when this message was sent."""
        events = self._saved('pending_call_events')
        relation = (self.w._current_session or {}).get('id')
        unconfirmed = {r['request_id'] for r in self._saved('pending_followup_receipts') if r['relationship_id']==relation}
        if not events and not unconfirmed: return None
        barrier = CallHistoryReceipt(request_id)
        barrier.events = events[-1:]
        barrier.unconfirmed = unconfirmed
        self.call_barriers.append(barrier)
        self.flush_call_events()
        if unconfirmed and self.w.immediate_followup:
            self.w.immediate_followup.recover_pending()
        return barrier

    def _saved_call_events(self, remaining, rejected=None):
        self._save('pending_call_events', remaining)
        self._advance_call_barriers(remaining,rejected)

    def followup_receipt_resolved(self, request_id):
        remaining = self._saved('pending_call_events')
        for barrier in self.call_barriers:
            if request_id in barrier.unconfirmed:
                barrier.unconfirmed.remove(request_id)
                barrier.events.extend(event for event in remaining if event['kind']=='interrupted'
                                      and event.get('request_id')==request_id and event not in barrier.events)
        self._advance_call_barriers(remaining)

    def _advance_call_barriers(self, remaining, rejected=None):
        waiting = []
        for barrier in self.call_barriers:
            if (rejected and rejected in barrier.events and rejected['kind']=='requesting'
                    and barrier.request_id==rejected.get('request_id')):
                barrier.rejected = True
            barrier.events = [event for event in barrier.events if event in remaining]
            if barrier.events or barrier.unconfirmed: waiting.append(barrier)
            else: barrier.set()
        self.call_barriers = waiting

    def flush_call_events(self):
        if self.call_writing or not self.ready: return
        events = self._saved('pending_call_events')
        if not events: return
        self.call_writing = True
        event = events[0]
        retry_without_group = bool(event.get('group_id'))
        def receive(data):
            nonlocal retry_without_group
            self.call_writing = False
            if not data.get('ok'):
                if data.get('code') != 'RELATIONSHIP_INPUT':
                    if not self.w._closing:
                        self.w.append_status('通话记录已暂存，正在重连。')
                        self.call_retry.start(self.call_retry_ms)
                        self.call_retry_ms = min(30000,2*self.call_retry_ms)
                    return
                if retry_without_group and '分组不存在' in str(data.get('error','')):
                    retry_without_group = False
                    self.call_writing = True
                    self.request('POST','/relationship/call',{**event,'group_id':None},receive,during_close=True)
                    return
                from core.chat_failure import record_failure
                record_failure({'code':'CALL_HISTORY_INVALID','detail':data.get('error','')},stage='call-history',
                               request_id=event.get('request_id'))
                if not self.w._closing:
                    self.w.append_status('这次播音位置未能对应原始通话记录。')
            self.call_retry_ms = 800
            remaining = [pending for pending in self._saved('pending_call_events') if pending!=event]
            rejected = not data.get('ok') or data.get('skipped') or data.get('removed')
            self._saved_call_events(remaining, event if rejected else None)
            if event['kind']=='ended' and not self.w._closing:
                self.arrival(event['group_id'])
            if remaining:
                self.flush_call_events()
            else:
                while self.call_waiting:
                    cid,text = self.call_waiting.popleft()
                    if not self.w._closing and cid == self.w._active_call_id:
                        self.w._on_asr_result(text)
        self.request('POST','/relationship/call',event,receive,during_close=True)

    def erase(self, ids):
        w = self.w
        if self.erasing or w._chat_busy or w.tts.is_speaking or (getattr(w,'speak_thread',None) and w.speak_thread.isRunning()):
            w.append_status('请等当前回复和播音结束后再删除。')
            return
        if QMessageBox.question(w,'删除这轮对话','删除这一轮双方的原话、回放和仅由它支撑的记忆或跟进事项？',
                QMessageBox.StandardButton.Yes|QMessageBox.StandardButton.No,QMessageBox.StandardButton.No)!=QMessageBox.StandardButton.Yes:
            return
        existing = self._saved('pending_turn_erasure')
        immediate = getattr(w,'immediate_followup',None)
        if immediate and immediate.current:
            job = immediate.current
            if job.parent in ids or (job.draft and job.draft['request_id'] in ids):
                immediate.cancel('source_removed')
        w._tts_queue = deque(task for task in w._tts_queue if getattr(task.get('row'),'request_id',None) not in ids)
        if getattr(getattr(w,'_pending_tts_row',None),'request_id',None) in ids:
            w._pending_tts = False
        self._save('pending_turn_erasure',list(dict.fromkeys([*existing,*ids])))
        self.resume_erasure()

    def resume_erasure(self):
        ids = self._saved('pending_turn_erasure')
        if self.erasing or not ids: return
        w = self.w
        self.erasing = True
        w._navigation_blocked = True
        w._update_composer_actions()
        def receive(data):
            self.erasing = False
            w._navigation_blocked = False
            if not data.get('ok') and data.get('code')=='RELATIONSHIP_ERASURE_UNKNOWN_ENTRY':
                remaining = [rid for rid in self._saved('pending_turn_erasure') if rid not in ids]
                self._save('pending_turn_erasure',remaining)
                self.shown.show_system_notice('记录中有当前版本无法识别的条目，已撤销这次删除并保留原档。')
                w._update_composer_actions()
                return
            try:
                if not data.get('ok') or not set(ids)<=set(data.get('request_ids',[])):
                    raise ValueError('删除收据尚未返回')
                sid = w._current_session['id']
                for replay in data.get('replay_ids',[]):
                    if not replay.startswith(sid+':'): raise ValueError('回放归属不符')
                    w.tts.audio_replay.forget_message(replay)
                for rid in ids:
                    w._pending_store.forget_request(sid,rid)
                if (w._failed_packet or {}).get('request_id') in ids:
                    w._failed_packet = w._failed_row = w._failed_chat = None
                    w._waiting_for_backend = False
                self._save('pending_turn_erasure',[])
                self._saved_call_events([event for event in self._saved('pending_call_events')
                                         if event.get('request_id') not in ids])
                self.acknowledge_replay_cleanup(data.get('replay_ids',[]))
            except (OSError,ValueError,TypeError,KeyError):
                self.shown.show_system_notice('删除等待完成。',on_retry=self.resume_erasure)
                w._update_composer_actions()
                return
            self.select(w._relationship_group_id,force=True)
        self.request('POST','/relationship/erase',{'request_ids':ids},receive)

    def clean_replays(self, ids):
        if not ids: return
        try:
            sid = self.w._current_session['id']
            for rid in ids:
                if not isinstance(rid,str) or not rid.startswith(sid+':'):
                    raise ValueError('回放归属不符')
                self.w.tts.audio_replay.forget_message(rid)
        except (OSError,ValueError):
            self.w.append_status('已删消息的回放等待清理。')
            return
        self.acknowledge_replay_cleanup(ids)

    def acknowledge_replay_cleanup(self, ids):
        for offset in range(0,len(ids),1000):
            self.request('POST','/relationship/replay-cleaned',{'ids':ids[offset:offset+1000]},lambda _:None)
