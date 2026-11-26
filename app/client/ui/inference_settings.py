"""Model-stage settings editor; network inspection runs outside the UI thread."""
import copy
from .themes import set_theme_style
from .pages import settings_form
from PyQt6.QtCore import QThread, pyqtSignal, Qt
from PyQt6.QtWidgets import (QWidget, QVBoxLayout, QHBoxLayout,
    QTabWidget, QComboBox, QSpinBox, QDoubleSpinBox, QLabel, QPushButton, QMessageBox, QSizePolicy)
from core.inference_config import load_inference, save_inference, CONFIG_PATH, DEEPSEEK_MODELS
from core.brain_client import BrainClient
from core.api_config import load_custom_api_profile

DESKTOP_PHASES = ('light', 'general_fast', 'general_quality', 'general_reply')
PHASE_NAMES = {'light':'轻量回复', 'general_fast':'快速分析', 'general_quality':'深度分析',
               'general_reply':'人格回复', 'analysis':'分析', 'reply':'回复', 'compression':'历史压缩'}


class EffectiveSettingsThread(QThread):
    received = pyqtSignal(dict)

    def run(self):
        try:
            self.received.emit(BrainClient().request('GET', '/inferenceSettings', timeout=3))
        except Exception:
            self.received.emit({'error': 'Brain 未启动或不支持新设置，请完整重启客户端后读取。'})


class InferenceSettings(QWidget):
    saved = pyqtSignal()

    def __init__(self, parent=None, phases=None):
        super().__init__(parent)
        self.setSizePolicy(QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Maximum)
        self.worker = None
        self.fields = {}
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0,0,0,0)
        layout.setSpacing(10)
        self.phases = tuple(phases or ('light', 'analysis', 'reply', 'compression'))
        simplified = self.phases == ('light',)
        desktop = any(phase.startswith('general_') for phase in self.phases)
        note = QLabel('四种模式共用上方模型连接。自动模式使用快速分析，必要时转深度；两者共用人格回复参数。' if desktop else
            '调整纯提示词模式，保存后下一轮生效。' if simplified else
            '分别调整回复、分析与历史压缩。保存后下一轮生效；“跟随对话模型”使用当前选择的模型。')
        note.setToolTip('这里只调整模型生成参数，不修改人格权重。工具访问范围在“工具权限”中设置。')
        note.setWordWrap(True)
        if not simplified:layout.addWidget(note)
        else:note.deleteLater()
        self.tabs = QTabWidget()
        if simplified:self.tabs.tabBar().hide()
        self.tabs.setObjectName('inferenceTabs')
        self._last_effective = None
        self.tabs.currentChanged.connect(self._show_effective_current)
        self.tabs.setDocumentMode(True)
        self.tabs.tabBar().setExpanding(False)
        set_theme_style(self.tabs,lambda p:f'''
            QTabWidget#inferenceTabs::pane {{border:0;}}
            QTabBar::tab {{color:{p['muted']};background:transparent;border:0;border-bottom:2px solid {p['border']};padding:7px 11px;}}
            QTabBar::tab:selected {{color:{p['text']};border-bottom-color:{p['accent']};}}
            QTabBar::tab:hover {{background:{p['field']};}}
        ''')
        layout.addWidget(self.tabs)
        for phase, name in PHASE_NAMES.items():
            if phase not in self.phases: continue
            general = phase.startswith('general_')
            page = QWidget()
            form = settings_form(page)
            form.setContentsMargins(1,10,1,4)
            f = self.fields[phase] = {}
            if phase != 'compression' and not general:
                model = f['model'] = QComboBox()
                model.setEditable(True)
                model.addItem('跟随对话模型', 'current')
                for m in DEEPSEEK_MODELS:
                    model.addItem(m['name'], 'deepseek/' + m['id'])
                custom = load_custom_api_profile()
                if custom:
                    model.addItem(custom['name'], 'custom-api/' + custom['model_id'])
                model.addItem('本地已启动模型', 'local/qwen')
                model.setToolTip('也可填写已注册的 provider/model ID；自定义 API 先在“模型服务”中配置。测试模型可能到期。')
                form.addRow('模型', model)
                if simplified or desktop:
                    form.setRowVisible(model, False)
            reasoning = f['reasoning'] = QComboBox()
            for label, value in [('沿用该模式当前设置' if general else '沿用会话设置','default'), ('关闭思考','off'), ('极低 · minimal','minimal'), ('低 · low','low'), ('中 · medium','medium'), ('高 · high','high'), ('更高 · xhigh','xhigh'), ('最高 · max','max')]:
                reasoning.addItem(label, value)
            reasoning.setToolTip('可用的思考档位取决于已配置的模型服务。')
            form.addRow('推理强度', reasoning)
            f['max_tokens'] = self.spin(0 if phase == 'light' or general else 256, 196608 if general else 262144)
            f['max_tokens'].setSpecialValueText('沿用该模式输出预算' if general else '沿用模型 / SDK 上限' if phase == 'light' else '')
            f['max_tokens'].setToolTip('输出上限，包含供应商计入额度的推理；不代表目标回复长度。')
            form.addRow('最大输出 tokens', f['max_tokens'])
            extra = form
            if desktop:
                panel = QWidget(page)
                extra = settings_form(panel)
                extra.setContentsMargins(0, 2, 0, 0)
                more = QPushButton('采样与超时参数')
                more.setCheckable(True)
                more.toggled.connect(panel.setVisible)
                toggles=QHBoxLayout();toggles.addWidget(more);toggles.addStretch()
                form.addRow(toggles)
                form.addRow(panel)
                panel.hide()
            f['timeout_seconds'] = self.spin(0 if general else 10, 1200)
            if general: f['timeout_seconds'].setSpecialValueText('沿用该模式超时')
            extra.addRow('单次请求超时（秒）', f['timeout_seconds'])
            if phase != 'compression':
                if not general:
                    f['context_window'] = self.spin(0 if phase == 'light' else 4096, 2000000)
                    if phase == 'light': f['context_window'].setSpecialValueText('沿用模型窗口 / Pi压缩')
                    extra.addRow('应用上下文窗口 tokens', f['context_window'])
                for key, title, maximum in [('temperature', 'Temperature', 2), ('top_p', 'Top P', 1)]:
                    field = f[key] = QDoubleSpinBox()
                    field.setRange(-1, maximum)
                    field.setDecimals(2)
                    field.setSingleStep(.05)
                    field.setSpecialValueText('服务默认（不发送）')
                    field.setToolTip('留在服务默认值，或填写当前模型和思考档位支持的采样参数。')
                    extra.addRow(title, field)
            else:
                for key, title in [('trigger', '输入预算使用达到此比例时压缩'), ('target', '压缩后目标比例')]:
                    field = f[key] = QDoubleSpinBox()
                    field.setRange(.05, .95)
                    field.setSingleStep(.05)
                    form.addRow(title, field)
                f['image_reserve'] = self.spin(1, 65536)
                form.addRow('每张图片估算预留 tokens', f['image_reserve'])
                note = QLabel('Deep Dive 两侧各自摘要，使用各自选定模型；低强度可在此更改。\n'
                    '输入预算还会扣除输出及安全余量；摘要有损，原始聊天和人格状态不删除。\n'
                    '自动重试：关闭。整轮 Deep Dive 最长 2 小时（含摘要），可随时取消。')
                note.setWordWrap(True)
                form.addRow(note)
            if phase != 'compression' and not desktop:
                hint = QLabel('最大输出是上限，不是回复长度。默认沿用现有配置；特殊参数按服务支持情况生效。')
                hint.setWordWrap(True)
                form.addRow(hint)
            self.tabs.addTab(page, name)
        row = QHBoxLayout()
        self.save_btn = QPushButton('保存设置（下一轮生效）')
        self.save_btn.setObjectName('primaryButton')
        self.save_btn.clicked.connect(self.save)
        self.refresh_btn = QPushButton('读取后端生效值')
        self.refresh_btn.clicked.connect(self.refresh_effective)
        row.addWidget(self.refresh_btn)
        row.addStretch()
        row.addWidget(self.save_btn)
        layout.addLayout(row)
        self.status = QLabel()
        self.status.setWordWrap(True)
        self.status.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        layout.addWidget(self.status)
        try:
            self.config = load_inference()
            self.populate(self.config)
            self.status.setText('已载入保存的设置；尚未读取后端生效值。')
            self.status.setToolTip('配置路径：' + str(CONFIG_PATH))
        except Exception as exc:
            self.config = None
            self.save_btn.setEnabled(False)
            self.status.setText('配置读取失败，未覆盖原文件：' + str(exc))

    @staticmethod
    def spin(low, high):
        widget = QSpinBox()
        widget.setRange(low, high)
        widget.setSingleStep(256 if high > 1000 else 10)
        return widget

    def select_mode(self, mode):
        phase = {'light':'light', 'general_fast':'general_fast', 'general_quality':'general_quality', 'general_auto':'general_fast'}.get(mode)
        for index in range(self.tabs.count()):
            if self.tabs.tabText(index) == PHASE_NAMES.get(phase):
                self.tabs.setCurrentIndex(index)
                break

    def populate(self, config):
        self.config = copy.deepcopy(config)
        for phase, fields in self.fields.items():
            for key, widget in fields.items():
                value = config[phase][key]
                if isinstance(widget, QComboBox):
                    index = widget.findData(value)
                    if index < 0:
                        widget.addItem(value, value)
                        index = widget.count() - 1
                    widget.setCurrentIndex(index)
                else:
                    widget.setValue(-1 if value is None else value)

    def values(self):
        # The file is also a supported editing entry. Merge only fields edited
        # in this form so an older open page cannot erase later file edits.
        result = copy.deepcopy(load_inference())
        baseline = self.config or result
        for phase, fields in self.fields.items():
            result[phase] = dict(result.get(phase, {}))
            for key, widget in fields.items():
                if isinstance(widget, QComboBox):
                    value = widget.currentData()
                    if key == 'model' and widget.currentText() != widget.itemText(widget.currentIndex()):
                        value = widget.currentText().strip()
                else:
                    value = widget.value()
                    if key in ('temperature', 'top_p') and value < 0: value = None
                if value != baseline.get(phase, {}).get(key):
                    result[phase][key] = value
        return result

    def save(self):
        config = self.values()
        try:
            for phase in ('light', 'analysis', 'reply'):
                if phase not in self.fields: continue
                s = config[phase]
                if not s['model'] or (s['model'] != 'current' and '/' not in s['model']): raise ValueError('模型需填写 provider/model ID')
                if s['context_window'] and (s['context_window'] < 4096 or s['max_tokens'] >= s['context_window'] * .8): raise ValueError('窗口至少4096，且需要为输入保留空间')
                if s['top_p'] == 0: raise ValueError('Top P必须大于0或设为默认')
            for phase in DESKTOP_PHASES[1:]:
                if phase not in self.fields: continue
                s = config[phase]
                if s['timeout_seconds'] and s['timeout_seconds'] < 10: raise ValueError('超时至少10秒，或设为0沿用')
                if s['top_p'] == 0: raise ValueError('Top P必须大于0或设为默认')
            if config['compression']['target'] >= config['compression']['trigger']: raise ValueError('压缩目标必须小于触发比例')
            save_inference(config)
            self.populate(config)
            self.status.setText('已保存，下一轮读取；正在生成的回复不受影响。可读取后端核对生效值。')
            self.saved.emit()
        except Exception as exc:
            QMessageBox.warning(self, '未保存', str(exc))

    def refresh_effective(self):
        if self.worker and self.worker.isRunning(): return
        self.refresh_btn.setEnabled(False)
        self.worker = EffectiveSettingsThread(self)
        self.worker.received.connect(self.show_effective)
        self.worker.finished.connect(lambda: self.refresh_btn.setEnabled(True))
        self.worker.start()

    def show_effective(self, result):
        if result.get('error') or not result.get('effective'):
            self.status.setText(result.get('error', '旧后端不支持，请重启客户端。'))
            return
        self._last_effective = result
        self._show_effective_current()

    def _show_effective_current(self, _index=None):
        result = self._last_effective
        if not result or not hasattr(self, 'status'): return
        names = PHASE_NAMES
        current = next((key for key in self.fields if names[key] == self.tabs.tabText(self.tabs.currentIndex())), None)
        lines = []
        for phase, value in result['effective'].items():
            if phase != current: continue
            if value.get('error'):
                lines.append(names[phase] + '：' + value['error'])
            else:
                lines.append(f"{names[phase]}：{value['provider']}/{value['model']} · 推理 {value['reasoning']} · 输出≤{value['max_tokens']} · 窗口 {value['context_window']} · 超时 {value['timeout_seconds']}秒")
                if value.get('note'): lines.append('  ' + value['note'])
                lines.append(f"  Temperature：{value.get('temperature') if value.get('temperature') is not None else '未发送'}；Top P：{value.get('top_p') if value.get('top_p') is not None else '未发送'}")
        compression = result.get('config', {}).get('compression', {})
        if compression and current == 'compression':
            lines.append(f"历史压缩：跟随各侧模型 · 推理 {compression['reasoning']} · 输出≤{compression['max_tokens']}（还受各侧输出预算限制） · 触发 {compression['trigger']:.0%} / 目标 {compression['target']:.0%}")
        self.status.setText('\n'.join(lines))
