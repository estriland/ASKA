"""User-controlled tool access; decisions are enforced again by the Brain."""
import json
import os
from pathlib import Path
from PyQt6.QtCore import QThread, pyqtSignal
from PyQt6.QtWidgets import QWidget, QVBoxLayout, QHBoxLayout, QLabel, QComboBox, QLineEdit, QPushButton, QFileDialog, QMessageBox, QCheckBox
from .pages import settings_form
from core.app_config import PROJECT_ROOT
from core.brain_client import BrainClient

MODES={'chat':'无权限', 'read_only':'只读', 'workspace':'项目内编辑', 'full':'完全权限'}
SCHEMA='asuka.tool-security/2'

def normalized_policy(value):
    if not isinstance(value,dict):raise ValueError('无效权限配置')
    current=value.get('schema')==SCHEMA
    gates=value.get('enabled') if isinstance(value.get('enabled'),dict) else {}
    enabled={'workspace':current and gates.get('workspace') is True,
             'full':current and gates.get('full') is True and value.get('full_access_confirmed') is True}
    mode=value.get('mode','chat')
    if mode not in MODES: raise ValueError('无效权限配置')
    if not current or mode in enabled and not enabled[mode]: mode='chat'
    return {'schema':SCHEMA,'mode':mode,'root':value.get('root','') if isinstance(value.get('root',''),str) else '',
            'enabled':enabled,'full_access_confirmed':enabled['full']}

def mode_available(policy, mode):
    return mode in ('chat','read_only') or normalized_policy(policy)['enabled'].get(mode,False)
def current_policy():
    path=Path(os.environ.get('ASUKA_SECURITY_CONFIG',PROJECT_ROOT/'client/security.local.json'))
    return normalized_policy(json.loads(path.read_text(encoding='utf-8')) if path.exists() else {})

def security_badge():
    try:
        p=current_policy()
        return '权限：'+('完全访问' if p['mode']=='full' else '未选工作区' if p['mode']!='chat' and not p.get('root') else MODES[p['mode']])
    except (OSError,ValueError,KeyError): return '权限配置错误'

class SecurityRequest(QThread):
    result=pyqtSignal(dict)
    def __init__(self,payload=None,parent=None,capabilities=False):
        super().__init__(parent);self.payload=payload;self.capabilities=capabilities
    def run(self):
        try:self.result.emit(BrainClient().request('POST' if self.payload is not None else 'GET','/security/capabilities' if self.capabilities else '/security',self.payload,timeout=3))
        except Exception as e:self.result.emit({'ok':False,'error':'无法连接安全设置接口，请重启新版客户端/Brain：'+str(e)})

class SecuritySettings(QWidget):
    policy_changed=pyqtSignal(dict)
    policy_error=pyqtSignal(str)
    def __init__(self,parent=None):
        super().__init__(parent);self.worker=None
        layout=QVBoxLayout(self)
        layout.setContentsMargins(0,0,0,0)
        layout.setSpacing(10)
        self.workspace_enabled=QCheckBox('允许选择项目内编辑')
        self.full_enabled=QCheckBox('允许选择完全权限')
        self.workspace_enabled.setToolTip('仅允许修改指定项目中的文件。')
        self.full_enabled.setToolTip('允许访问当前系统用户的文件并运行命令；不自动提权。')
        layout.addWidget(self.workspace_enabled);layout.addWidget(self.full_enabled)
        form=settings_form();layout.addLayout(form)
        self.mode=QComboBox()
        for key,name in MODES.items():self.mode.addItem(name,key)
        form.addRow('权限级别',self.mode)
        self.folder=QLineEdit();self.folder.setPlaceholderText('请选择专门的项目文件夹；未选择时不能操作文件')
        row=QHBoxLayout();row.addWidget(self.folder)
        choose=QPushButton('选择文件夹');choose.clicked.connect(self.choose);row.addWidget(choose)
        form.addRow('允许访问范围',row)
        self.note=QLabel('只读和项目内编辑限于指定文件夹。完全权限可访问当前系统账户允许的文件和命令。')
        self.note.setObjectName('cardDescription')
        self.note.setWordWrap(True);layout.addWidget(self.note)
        self.note.setToolTip('这是本地文件工具的访问限制，不是操作系统沙箱。\n轻量模式可调用本地工具；快速、深度和自动暂不调用这些工具。')
        buttons=QHBoxLayout();self.apply=QPushButton('应用安全设置');self.apply.setObjectName('primaryButton');self.apply.clicked.connect(self.save)
        self.refresh=QPushButton('读取生效配置');self.refresh.clicked.connect(lambda:self.request())
        buttons.addWidget(self.refresh);buttons.addStretch();buttons.addWidget(self.apply);layout.addLayout(buttons)
        self.status=QLabel();self.status.setWordWrap(True);layout.addWidget(self.status)
        self._saved=normalized_policy({})
        self.workspace_enabled.toggled.connect(self._sync_choices)
        self.full_enabled.toggled.connect(self._sync_choices)
        try:self.populate(current_policy())
        except Exception as e:self.status.setText('配置读取失败：'+str(e))
    def populate(self,p):
        p=normalized_policy(p);self._saved=p
        for checkbox, key in ((self.workspace_enabled,'workspace'),(self.full_enabled,'full')):
            checkbox.blockSignals(True);checkbox.setChecked(p['enabled'][key]);checkbox.blockSignals(False)
        self._sync_choices()
        self.mode.setCurrentIndex(max(0,self.mode.findData(p['mode'])));self.folder.setText(p.get('root',''))
        scope='不限制文件范围' if p.get('mode')=='full' else '工具全部关闭' if p.get('mode')=='chat' else p.get('root') or '未选择（文件工具关闭）'
        self.status.setText('已保存：'+MODES.get(p.get('mode'),'未知')+'；范围：'+scope)
    def _sync_choices(self):
        for key,checkbox in (('workspace',self.workspace_enabled),('full',self.full_enabled)):
            self.mode.model().item(self.mode.findData(key)).setEnabled(checkbox.isChecked())
            if self.mode.currentData()==key and not checkbox.isChecked():self.mode.setCurrentIndex(self.mode.findData('chat'))
    def choose(self):
        folder=QFileDialog.getExistingDirectory(self,'选择允许Agent操作的项目文件夹',self.folder.text())
        if folder:self.folder.setText(folder)
    def save(self):
        mode=self.mode.currentData()
        enabling_full=self.full_enabled.isChecked() and not self._saved['enabled']['full']
        if enabling_full:
            answer=QMessageBox.warning(self,'确认开启完全权限',
                '完全权限允许Agent读取或修改当前用户可访问的文件、运行程序和访问网络，可能接触密钥和私人数据。\n不受项目文件夹限制，不是管理员提权；设置会保留到下次启动。确认开启？',
                QMessageBox.StandardButton.Yes|QMessageBox.StandardButton.No,QMessageBox.StandardButton.No)
            if answer!=QMessageBox.StandardButton.Yes:return
        self.request({'mode':mode,'root':self.folder.text().strip(),
                      'enabled':{'workspace':self.workspace_enabled.isChecked(),'full':self.full_enabled.isChecked()},
                      'full_access_confirmed':self.full_enabled.isChecked()},capabilities=True)
    def select_mode(self,mode,root):
        # Quick selection never sends unsaved capability checkbox values.
        self.request({'mode':mode,'root':root})
    def request(self,payload=None,capabilities=False):
        if self.worker and self.worker.isRunning():return
        self.apply.setEnabled(False);self.refresh.setEnabled(False)
        self.worker=SecurityRequest(payload,self,capabilities=capabilities);self.worker.result.connect(self.received)
        self.worker.finished.connect(lambda:(self.apply.setEnabled(True),self.refresh.setEnabled(True)))
        self.worker.start()
    def received(self,result):
        if not result.get('ok'):
            error=str(result.get('error','旧后端不支持，请重启'))
            self.status.setText('未应用：'+error);self.policy_error.emit(error);return
        self.populate(result['policy']);self.policy_changed.emit(result['policy'])
