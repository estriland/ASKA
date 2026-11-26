from pathlib import Path
from PyQt6.QtCore import QSignalBlocker,pyqtSignal
from PyQt6.QtWidgets import QComboBox,QHBoxLayout,QLabel,QPlainTextEdit,QPushButton,QSizePolicy,QWidget
from core.app_config import PROJECT_ROOT
from core.role_settings import LABELS,PATH,builtin_role_fields,load_role_settings,save_role_settings
from .file_navigation import reveal_configuration
from .pages import SettingsCard,settings_form
from .appearance import RoleBanner
from .composer_bar import composer_icon
from .themes import colors


class RoleSettingsCard(SettingsCard):
    saved=pyqtSignal()

    def __init__(self,parent=None,*,path=PATH,memory_root=None):
        super().__init__('角色设定','',parent)
        self.setSizePolicy(QSizePolicy.Policy.Expanding,QSizePolicy.Policy.Maximum)
        self.path=Path(path)
        self.fields={}
        self.status=QLabel()
        self.status.setObjectName('mutedLabel')
        self.status.setWordWrap(True)
        self.status.hide()
        image=PROJECT_ROOT/'assets/chat_background.png'
        if image.is_file():
            self.content.addWidget(RoleBanner(image))
        form=settings_form()
        detail=QWidget()
        more=settings_form(detail)
        more.setContentsMargins(0,4,0,4)
        self.origin_mode=QComboBox()
        self.origin_mode.addItem('使用内置身世','builtin')
        self.origin_mode.addItem('自定义完整身世','replace')
        self.origin_mode.addItem('补充内置身世','extend')
        self.origin_mode.setAccessibleName('身世来源')
        for key in ('current_life','speaking_style','life_premise','origin'):
            label=LABELS[key]
            field=QPlainTextEdit()
            field.setAccessibleName(label)
            field.setFixedHeight(field.fontMetrics().lineSpacing()*(4 if key=='speaking_style' else 3 if key=='origin' else 2)+21)
            self.fields[key]=field
            section=more if key in ('life_premise','origin') else form
            if key=='origin':section.addRow('身世来源',self.origin_mode)
            section.addRow(label,field)
        self.fields['current_life'].setPlaceholderText('最近住在哪里，在忙什么？')
        self.fields['speaking_style'].setPlaceholderText('例如语气平静，熟悉以后会开些小玩笑。')
        self.origin_help=QLabel()
        self.origin_help.setWordWrap(True)
        self.origin_help.setObjectName('cardDescription')
        self.origin_help.setSizePolicy(QSizePolicy.Policy.Preferred,QSizePolicy.Policy.Maximum)
        more.addRow('',self.origin_help)
        self.content.addLayout(form)
        self.detail_button=QPushButton('生活起点与身世')
        self.detail_button.setIcon(composer_icon('chevron-right',colors()['accent']))
        self.detail_button.setObjectName('detailDisclosure')
        self.detail_button.setAccessibleName('生活起点与身世')
        self.detail_button.setCheckable(True)
        self.detail_button.toggled.connect(detail.setVisible)
        self.detail_button.toggled.connect(lambda open_:self.detail_button.setIcon(composer_icon(
            'chevron-down' if open_ else 'chevron-right',colors()['accent'])))
        self.content.addWidget(self.detail_button)
        self.content.addWidget(detail)
        detail.hide()
        row=QHBoxLayout()
        self.reset_button=QPushButton('恢复内置内容')
        self.reset_button.clicked.connect(self.restore_default)
        self.locate=QPushButton('配置文件')
        self.locate.setObjectName('configFileLink')
        self.locate.clicked.connect(self.reveal)
        self.save_button=QPushButton('保存设定')
        self.save_button.setToolTip('对所有对话的下一条消息生效')
        self.save_button.setObjectName('primaryButton')
        self.save_button.clicked.connect(self.save)
        row.addWidget(self.reset_button);row.addStretch();row.addWidget(self.locate);row.addWidget(self.save_button)
        self.content.addWidget(self.status);self.content.addLayout(row)
        try:
            self.defaults=builtin_role_fields(memory_root)
            fields=load_role_settings(self.path)['overrides']
        except (KeyError,OSError,ValueError) as error:
            self.defaults=dict.fromkeys(LABELS,'')
            fields={}
            self._status(f'无法读取角色设定，请检查配置文件：{error}')
            self.save_button.setEnabled(False)
        self._fill(fields)
        self.origin_mode.currentIndexChanged.connect(self._switch_origin)
        self.fields['origin'].textChanged.connect(self._direct_origin_edit)
        self.locate.setEnabled(self.path.is_file())

    def _fill(self,overrides):
        origin=overrides.get('origin',{'mode':'builtin','text':self.defaults['origin']})
        self.origin_drafts={'builtin':self.defaults['origin'],'replace':self.defaults['origin'],'extend':''}
        self._direct_replace=False
        self.mode=origin['mode']
        self.origin_drafts[self.mode]=origin['text']
        self.origin_mode.blockSignals(True)
        self.origin_mode.setCurrentIndex(self.origin_mode.findData(self.mode))
        self.origin_mode.blockSignals(False)
        with QSignalBlocker(self.fields['origin']):
            for key,field in self.fields.items():
                field.setPlainText(origin['text'] if key=='origin' else overrides.get(key,self.defaults[key]))
        self._describe_origin()

    def _describe_origin(self):
        self.origin_help.setText({'builtin':'跟随内置角色资料。直接编辑正文即可自定义身世。',
            'extend':'在这里填写新增背景，与内置往事一起使用。',
            'replace':'保存后，往事来自这段自定义背景和实际对话。'}[self.mode])

    def _direct_origin_edit(self):
        text=self.fields['origin'].toPlainText()
        if self.mode=='builtin' and text!=self.defaults['origin']:
            self.mode='replace';self._direct_replace=True
        elif self._direct_replace and text==self.defaults['origin']:
            self.mode='builtin';self._direct_replace=False
        else:
            return
        # Keep cursor, selection and undo history in the actual editor.
        with QSignalBlocker(self.origin_mode):
            self.origin_mode.setCurrentIndex(self.origin_mode.findData(self.mode))
        self._describe_origin()

    def _switch_origin(self):
        self.origin_drafts[self.mode]=self.fields['origin'].toPlainText()
        self.mode=self.origin_mode.currentData()
        self._direct_replace=False
        with QSignalBlocker(self.fields['origin']):
            self.fields['origin'].setPlainText(self.origin_drafts[self.mode])
        self._describe_origin()

    def restore_default(self):
        self._fill({})
        self._status('已载入内置内容，保存后生效。')

    def _status(self,text):
        self.status.setText(text)
        self.status.setVisible(bool(text))

    def save(self):
        overrides={}
        for key,field in self.fields.items():
            text=field.toPlainText().strip()
            if key=='origin':
                if self.mode=='replace' or (self.mode=='extend' and text):
                    overrides[key]={'mode':self.mode,'text':text}
            elif text!=self.defaults[key]:overrides[key]=text
        try:save_role_settings(overrides,self.path)
        except (OSError,ValueError) as error:
            self._status(str(error))
            return
        self.locate.setEnabled(True)
        self._status('已保存，下一条新消息生效。')
        self.saved.emit()

    def reveal(self):
        try:reveal_configuration(self.path)
        except (OSError,ValueError) as error:self._status(str(error))
