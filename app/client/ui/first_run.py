"""First-use setup for a desktop profile, before the Brain or audio workers start."""
from PyQt6.QtCore import QSettings
from PyQt6.QtWidgets import (
    QFrame, QHBoxLayout, QLabel, QPushButton, QScrollArea, QStackedWidget, QVBoxLayout, QWidget,
)
from core.api_config import LEGACY_ID, load_api_connections, normalize_custom_api_profile, save_custom_api_profile, saved_api_provider
from core.app_config import LOCAL_CONFIG_PATH, deepseek_api_key
from core.dialogue_profile import CONFIG_PATH, normalize_dialogue_defaults, save_dialogue_defaults
from ui.api_connection import ApiConnectionFields
from ui.dialogue_settings import DialogueSettingsCard
from ui.window_frame import ThemedDialog
from ui.themes import desktop_surface_style,set_theme_style

STATUS = 'setup/initial-configuration-v1'


def needs_setup(settings, *, explicit=False, config_path=LOCAL_CONFIG_PATH):
    state = settings.value(STATUS,'')
    if state=='complete':
        return False
    if explicit or state=='pending':
        return True
    try:
        book=load_api_connections(config_path)
        return not book.profiles and saved_api_provider(settings.value('api/provider'),book.active,config_path)=='none'
    except (OSError,ValueError):
        return True


class FirstRunDialog(ThemedDialog):
    def __init__(self,settings,*,config_path=LOCAL_CONFIG_PATH,dialogue_path=CONFIG_PATH):
        super().__init__()
        self.settings=settings
        self.config_path=config_path
        self.setWindowTitle('ASKA · 首次设置')
        self.resize(600,525)
        self.pages=QStackedWidget()
        self.identity=DialogueSettingsCard(path=dialogue_path,first_run=True)
        self.pages.addWidget(self._scroll(self.identity))
        service=QWidget()
        layout=QVBoxLayout(service)
        heading=QLabel('模型连接');heading.setObjectName('setupHeading')
        layout.addWidget(heading)
        self.api=ApiConnectionFields(service)
        layout.addWidget(self.api)
        layout.addStretch()
        self.pages.addWidget(self._scroll(service))
        self.body_layout.setContentsMargins(23,17,23,18)
        top=QHBoxLayout()
        top.addStretch()
        self.step=QLabel()
        self.step.setObjectName('mutedLabel')
        top.addWidget(self.step)
        self.body_layout.addLayout(top)
        set_theme_style(self.pages,lambda palette:desktop_surface_style(palette)+f'''
            QLineEdit,QPlainTextEdit,QComboBox {{background:{palette['field']};color:{palette['text']};
                padding:7px;border:1px solid {palette['border']};border-radius:7px;}}
            QLabel#setupHeading {{color:{palette['text']};font-size:19px;font-weight:650;}}
        ''')
        self.body_layout.addWidget(self.pages,1)
        self.notice=QLabel()
        self.notice.setWordWrap(True)
        self.body_layout.addWidget(self.notice)
        actions=QHBoxLayout()
        self.later=QPushButton('稍后设置');self.later.clicked.connect(self.reject)
        self.back=QPushButton('上一步');self.back.clicked.connect(lambda:self._page(0))
        for button in (self.later,self.back):
            set_theme_style(button,lambda c:f'background:{c["field"]};color:{c["text"]};border:1px solid {c["border"]};border-radius:7px;padding:7px 12px;')
        self.next=QPushButton('下一步');self.next.setObjectName('primaryButton');self.next.clicked.connect(self.advance)
        set_theme_style(self.next,lambda c:f'background:{c["control"]};color:{c["on_control"]};border-radius:8px;padding:8px 15px;font-weight:650;')
        self.next.setMinimumWidth(self.next.fontMetrics().horizontalAdvance('保存并开始')+48)
        actions.addWidget(self.later);actions.addStretch();actions.addWidget(self.back);actions.addWidget(self.next)
        self.body_layout.addLayout(actions)
        self._active_id=None
        try:
            book=load_api_connections(config_path)
            self._active_id=book.active_id
            if book.active:self.api.load(book.active)
            elif saved_api_provider(settings.value('api/provider'),None,config_path)=='deepseek':
                self.api.load({'name':'DeepSeek','base_url':'https://api.deepseek.com','api_key':deepseek_api_key(),
                    'model_id':str(settings.value('api/deepseek_model','deepseek-v4-pro')),'supports_reasoning':True,
                    'supports_vision':True,'context_window':1000000,'max_tokens':196608})
        except (OSError,ValueError) as error:
            self.notice.setText(f'读取模型配置失败：{config_path}\n{error}');self.next.setEnabled(False)
        if not self.identity.save_button.isEnabled():
            self.notice.setText(self.identity.status.text());self.next.setEnabled(False)
        self._page(0)

    @staticmethod
    def _scroll(widget):
        scroll=QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.Shape.NoFrame)
        scroll.setWidget(widget)
        return scroll

    def _page(self,index):
        self.pages.setCurrentIndex(index)
        self.step.setText(f'{index+1} / 2')
        self.step.setAccessibleName(f'首次设置，第{index+1}步，共2步')
        self.setWindowTitle('ASKA · 模型连接' if index else 'ASKA · 首次设置')
        self.back.setVisible(index==1)
        self.next.setText('保存并开始' if index else '下一步')
        if self.next.isEnabled():self.notice.clear()

    def _write_status(self,value):
        self.settings.setValue(STATUS,value)
        self.settings.sync()
        if self.settings.status()!=QSettings.Status.NoError:
            raise OSError('首次设置状态保存失败，请检查资料目录')

    def advance(self):
        try:
            identity=normalize_dialogue_defaults(self.identity.values())
            if self.pages.currentIndex()==0:
                self._page(1)
                return
            profile=normalize_custom_api_profile(self.api.values())
            self._write_status('pending')
            save_dialogue_defaults(identity,self.identity.path)
            active=save_custom_api_profile(profile,self.config_path,connection_id=self._active_id,new=self._active_id is None)
            self._active_id=active.get('connection_id',LEGACY_ID)
            self.settings.setValue('api/provider','custom-api')
            self._write_status('complete')
        except (OSError,ValueError) as error:
            self.notice.setText(str(error))
            return
        self.accept()
