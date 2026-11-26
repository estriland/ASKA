"""Shared connection editor for Settings and first launch."""
from urllib.parse import urlparse
from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import (
    QCheckBox, QComboBox, QHBoxLayout, QLineEdit,
    QPushButton, QSpinBox, QVBoxLayout, QWidget,
)
from .pages import settings_form


class ApiConnectionFields(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0,0,0,0)
        form = settings_form()
        layout.addLayout(form)
        self.name = QLineEdit()
        self.name.setMaxLength(80)
        self.name.setPlaceholderText('例如：日常聊天')
        self.address = QLineEdit()
        self.address.setPlaceholderText('https://api.example.com/v1')
        self.key = QLineEdit()
        self.key.setEchoMode(QLineEdit.EchoMode.Password)
        self.key.setPlaceholderText('按服务要求填写，本地服务可留空')
        self.model = QLineEdit()
        self.model.setPlaceholderText('服务提供的模型 ID')
        for title,field in [('连接名称',self.name),('API 地址',self.address),('API Key',self.key),('模型名称',self.model)]:
            field.setAccessibleName(title)
            form.addRow(title,field)
        self.advanced_button=QPushButton('高级设置')
        self.advanced_button.setObjectName('compactButton')
        self.advanced_button.setCheckable(True)
        layout.addWidget(self.advanced_button,alignment=Qt.AlignmentFlag.AlignLeft)
        self.advanced_panel=QWidget()
        extra=settings_form(self.advanced_panel)
        extra.setContentsMargins(0,2,0,0)
        self.protocol=QComboBox()
        for label,value in [('OpenAI 兼容','openai-completions'),('OpenAI Responses','openai-responses'),
                            ('Anthropic Messages','anthropic-messages'),('Google Generative AI','google-generative-ai')]:
            self.protocol.addItem(label,value)
        extra.addRow('协议',self.protocol)
        self.context=QSpinBox();self.context.setRange(4096,2_000_000);self.context.setSingleStep(4096)
        self.max_output=QSpinBox();self.max_output.setRange(256,262144);self.max_output.setSingleStep(1024)
        extra.addRow('上下文窗口',self.context)
        extra.addRow('最大输出',self.max_output)
        self.vision=QCheckBox('支持图片输入')
        self.reasoning=QCheckBox('服务支持思考参数')
        flags=QHBoxLayout();flags.addWidget(self.vision);flags.addWidget(self.reasoning);flags.addStretch()
        extra.addRow('',flags)
        layout.addWidget(self.advanced_panel)
        self.advanced_panel.hide()
        self.advanced_button.toggled.connect(self._toggle_advanced)
        self.address.textEdited.connect(self.address_edited)
        self.load({})

    def _toggle_advanced(self, enabled):
        self.advanced_panel.setVisible(enabled)
        self.advanced_button.setText('收起高级设置' if enabled else '高级设置')

    @staticmethod
    def origin(address):
        try:
            parsed=urlparse(address.strip())
            return parsed.scheme,parsed.netloc.lower()
        except ValueError:
            return '',''

    def address_edited(self,address):
        origin=self.origin(address)
        if origin==self._origin or origin[0] not in ('http','https') or not origin[1]:
            return
        if self._origin[1]:
            self.key.clear()
        self._origin=origin
        official=origin==('https','api.deepseek.com')
        self.context.setValue(1000000 if official else 128000)
        self.max_output.setValue(196608 if official else 8192)
        self.reasoning.setChecked(official)

    def load(self, profile):
        self.name.setText(profile.get('name',''))
        self.address.setText(profile.get('base_url',''))
        self.key.setText(profile.get('api_key',''))
        self.model.setText(profile.get('model_id',''))
        self.protocol.setCurrentIndex(max(0,self.protocol.findData(profile.get('api_type','openai-completions'))))
        self.context.setValue(profile.get('context_window',128000))
        self.max_output.setValue(profile.get('max_tokens',8192))
        self.vision.setChecked(profile.get('supports_vision',False))
        self.reasoning.setChecked(profile.get('supports_reasoning',False))
        self._origin=self.origin(self.address.text())
        self.initial=self.values()

    def values(self):
        return {'name':self.name.text().strip() or self.model.text().strip(),
            'base_url':self.address.text(),'api_key':self.key.text(),'model_id':self.model.text(),
            'api_type':self.protocol.currentData(),'supports_vision':self.vision.isChecked(),
            'supports_reasoning':self.reasoning.isChecked(),'context_window':self.context.value(),
            'max_tokens':self.max_output.value()}
