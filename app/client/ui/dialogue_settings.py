"""Small new-chat defaults card; saving never edits an active conversation."""
from pathlib import Path
from PyQt6.QtCore import pyqtSignal
from PyQt6.QtWidgets import QHBoxLayout,QLabel,QLineEdit,QPlainTextEdit,QPushButton
from core.dialogue_profile import CONFIG_PATH,SCHEMA,load_dialogue_defaults,save_dialogue_defaults
from .pages import SettingsCard,settings_form
from .file_navigation import reveal_configuration

class DialogueSettingsCard(SettingsCard):
    saved=pyqtSignal(dict)

    def __init__(self,parent=None,path=CONFIG_PATH,*,first_run=False):
        super().__init__('设定角色' if first_run else '你的开场资料',
            '称呼、身份和开场关系都可以留空。' if first_run else '首次建立对话时使用。切换话题分组会延续同一段关系。',parent)
        self.path=Path(path)
        form=settings_form()
        self.address=QLineEdit();self.address.setPlaceholderText('角色对你的称呼');self.address.setMaxLength(80);self.address.setAccessibleName('用户称呼')
        form.addRow('称呼',self.address)
        self.identity=QPlainTextEdit();self.identity.setFixedHeight(self.identity.fontMetrics().lineSpacing()*2+19);self.identity.setPlaceholderText('你的身份或背景');self.identity.setAccessibleName('用户身份简介')
        self.relationship=QPlainTextEdit();self.relationship.setFixedHeight(self.relationship.fontMetrics().lineSpacing()*2+19);self.relationship.setPlaceholderText('例如同学或同事');self.relationship.setAccessibleName('开场关系背景')
        self.relationship.setToolTip('描述这段对话的起点，不会固定好感或抹掉后续相处的变化。')
        form.addRow('身份简介',self.identity);form.addRow('开场关系',self.relationship);self.content.addLayout(form)
        buttons=QHBoxLayout();self.status=QLabel();self.status.setObjectName('mutedLabel');self.status.setWordWrap(True);buttons.addWidget(self.status,1)
        self.locate=QPushButton('配置文件');self.locate.setObjectName('configFileLink');self.locate.clicked.connect(self.reveal);buttons.addWidget(self.locate)
        self.save_button=QPushButton('保存');self.save_button.setObjectName('primaryButton');self.save_button.clicked.connect(self.save);buttons.addWidget(self.save_button);self.content.addLayout(buttons)
        self.reload()
        if first_run:
            self.locate.hide()
            self.save_button.hide()

    def values(self):
        return {'schema':SCHEMA,'address':self.address.text(),'identity_intro':self.identity.toPlainText(),
                'opening_relationship':self.relationship.toPlainText(),'tic_preference':'natural'}

    def reload(self):
        try:
            value=load_dialogue_defaults(self.path)
            self.address.setText(value['address']);self.identity.setPlainText(value['identity_intro']);self.relationship.setPlainText(value['opening_relationship'])
            self.save_button.setEnabled(True)
        except (OSError,ValueError) as error:
            self.status.setText(str(error));self.save_button.setEnabled(False)
        self.locate.setEnabled(self.path.is_file())

    def save(self):
        try:
            value=save_dialogue_defaults(self.values(),self.path)
            self.status.setText('已保存，新对话生效');self.locate.setEnabled(True);self.saved.emit(value)
        except (OSError,ValueError) as error:self.status.setText(str(error))

    def reveal(self):
        try:reveal_configuration(self.path)
        except (OSError,ValueError) as error:self.status.setText(str(error))
