# -*- coding: utf-8 -*-
"""主窗口的设置卡片与 TTS 异常中心。"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from .themes import colors, set_theme_style
from .composer_bar import composer_icon
from .appearance import SidebarToggle
from PyQt6.QtCore import QSize, Qt, QUrl, pyqtSignal
from PyQt6.QtGui import QColor, QDesktopServices
from PyQt6.QtWidgets import (
    QFrame, QFormLayout, QMenu,
    QHBoxLayout,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QPushButton,
    QScrollArea,
    QTabWidget,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)


def settings_form(parent=None):
    form = QFormLayout(parent)
    form.setContentsMargins(0, 0, 0, 0)
    form.setHorizontalSpacing(16)
    form.setVerticalSpacing(10)
    form.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
    form.setRowWrapPolicy(QFormLayout.RowWrapPolicy.WrapLongRows)
    return form


def _read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return {}


@dataclass(frozen=True)
class DiagnosticSummary:
    sample_id: str
    folder: Path
    captured_at: str
    categories: tuple[str, ...]
    note: str
    duration_s: float
    engine: str
    reviewed: bool
    verdict: str
    findings: tuple[str, ...]
    next_experiments: tuple[str, ...]


def load_diagnostic_summaries(root: Path) -> list[DiagnosticSummary]:
    """读取已提交的 TTS 报告；损坏的单个 JSON 不影响其余条目。"""
    root = Path(root)
    if not root.exists():
        return []
    summaries = []
    folders = sorted(
        (item for item in root.iterdir() if item.is_dir()),
        key=lambda item: item.name,
        reverse=True,
    )
    for folder in folders:
        annotation = _read_json(folder / "annotation.json")
        if not annotation:
            continue
        metadata = _read_json(folder / "metadata.json")
        review = _read_json(folder / "review.json")
        duration_ms = metadata.get("audio_duration_ms", 0)
        try:
            duration_s = float(duration_ms) / 1000.0
        except (TypeError, ValueError):
            duration_s = 0.0
        summaries.append(DiagnosticSummary(
            sample_id=str(annotation.get("sample_id") or folder.name),
            folder=folder,
            captured_at=str(
                annotation.get("annotated_at")
                or metadata.get("captured_at") or ""),
            categories=tuple(str(value) for value in
                             annotation.get("categories", []) if value),
            note=str(annotation.get("note") or ""),
            duration_s=duration_s,
            engine=str(metadata.get("engine") or "未知引擎"),
            reviewed=bool(review),
            verdict=str(review.get("verdict") or ""),
            findings=tuple(str(value) for value in
                           review.get("findings", []) if value),
            next_experiments=tuple(str(value) for value in
                                  review.get("next_experiments", []) if value),
        ))
    return summaries


class SettingsPage(QWidget):
    """按任务分类；各分类独立滚动，切换时保留未保存的编辑。"""

    def __init__(self, parent=None, *, sidebar_action=None):
        super().__init__(parent)
        self.navigation = QListWidget()
        self.navigation.setObjectName('settingsSections')
        self.navigation.setAccessibleName('设置分类')
        self.navigation.setIconSize(QSize(18,18))
        self.navigation.setUniformItemSizes(True)
        self.navigation.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(24, 20, 18, 12)
        layout.setSpacing(10)
        self.heading = QLabel()
        self.heading.setObjectName('pageTitle')
        header = QHBoxLayout()
        self.sidebar_toggle = SidebarToggle(sidebar_action) if sidebar_action is not None else None
        if self.sidebar_toggle is not None:
            header.addWidget(self.sidebar_toggle)
        header.addWidget(self.heading,1)
        layout.addLayout(header)
        self.tabs = QTabWidget()
        self.tabs.setObjectName("settingsTabs")
        self.tabs.tabBar().hide()
        self.tabs.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self.navigation.currentRowChanged.connect(self.tabs.setCurrentIndex)
        self.tabs.currentChanged.connect(self._section_changed)
        set_theme_style(self.tabs, 'QTabWidget#settingsTabs::pane { border:0; margin:0; padding:0; }')
        layout.addWidget(self.tabs)

    def resizeEvent(self, event):
        width=event.size().width()
        # Keep headings and fields on the same readable column on a wide
        # monitor, and give the field space back at compact widths.
        inset=max(14,min(32,width//24),(width-820)//2)
        self.layout().setContentsMargins(inset,20,inset,12)
        super().resizeEvent(event)

    def _section_changed(self, index):
        self.navigation.setCurrentRow(index)
        self.heading.setText(self.tabs.tabText(index))

    def add_section(self, title, icon):
        scroll = QScrollArea()
        scroll.setObjectName("settingsScroll")
        scroll.setAccessibleName(title+'设置')
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.Shape.NoFrame)
        page = QWidget()
        page.setObjectName('settingsCanvas')
        content = QVBoxLayout(page)
        content.setContentsMargins(0, 8, 5, 9)
        content.setSpacing(14)
        content.setAlignment(Qt.AlignmentFlag.AlignTop)
        scroll.setWidget(page)
        item=QListWidgetItem(composer_icon(icon,colors()['text']),title)
        item.setSizeHint(QSize(0,max(37,self.navigation.fontMetrics().height()+17)))
        self.navigation.addItem(item)
        self.tabs.addTab(scroll, title)
        return content


class SettingsCard(QFrame):
    """设置页使用的统一分区卡片。"""

    def __init__(self, title: str, description: str = "", parent=None, *, collapsible=False):
        super().__init__(parent)
        self.setObjectName("settingsCard")
        layout = QVBoxLayout(self)
        layout.setContentsMargins(18, 16, 18, 16)
        layout.setSpacing(7)
        self.header = QHBoxLayout()
        if collapsible:
            title_label=QPushButton(title)
            title_label.setObjectName('detailDisclosure')
            title_label.setCheckable(True)
            title_label.setIcon(composer_icon('chevron-right',colors()['accent']))
            title_label.setAccessibleName('展开或收起'+title)
            self.disclosure=title_label
        else:
            title_label = QLabel(title)
            title_label.setObjectName("cardTitle")
        self.header.addWidget(title_label,1)
        layout.addLayout(self.header)
        if description:
            description_label = QLabel(description)
            description_label.setObjectName("cardDescription")
            description_label.setWordWrap(True)
            layout.addWidget(description_label)
        self.content = QVBoxLayout()
        self.content.setContentsMargins(0, 5, 0, 0)
        self.content.setSpacing(10)
        if collapsible:
            body=QWidget()
            body.setLayout(self.content)
            layout.addWidget(body)
            body.hide()
            title_label.toggled.connect(body.setVisible)
            title_label.toggled.connect(lambda showing:title_label.setIcon(composer_icon(
                'chevron-down' if showing else 'chevron-right',colors()['accent'])))
        else:
            layout.addLayout(self.content)

    def add_resource_menu(self, title, buttons):
        """Keep existing command handlers and their current enabled state."""
        trigger=QPushButton(title)
        trigger.setObjectName('cardTools')
        menu=QMenu(trigger)
        commands=[]
        for button in buttons:
            button.setParent(self)
            button.hide()
            action=menu.addAction(button.text(),button.click)
            commands.append((button,action))
        def update_menu():
            for button,action in commands:
                action.setText(button.text())
                action.setEnabled(button.isEnabled())
        menu.aboutToShow.connect(update_menu)
        trigger.setMenu(menu)
        self.header.addWidget(trigger)
        return trigger


class DiagnosticsPage(QWidget):
    """浏览已经标注的 TTS 异常及自动审阅结果。"""

    pending_count_changed = pyqtSignal(int)

    def __init__(self, reports_root: Path, parent=None):
        super().__init__(parent)
        self.reports_root = Path(reports_root)
        self._reports: list[DiagnosticSummary] = []
        layout = QVBoxLayout(self)
        layout.setContentsMargins(20, 18, 20, 20)
        layout.setSpacing(14)

        header = QHBoxLayout()
        title_box = QVBoxLayout()
        title = QLabel("异常样本")
        title.setObjectName("pageTitle")
        title_box.addWidget(title)
        subtitle = QLabel("对话中提交的语音问题会自动汇总在这里；已审阅样本保留结论和下一步实验。")
        subtitle.setObjectName("pageSubtitle")
        subtitle.setWordWrap(True)
        title_box.addWidget(subtitle)
        header.addLayout(title_box, stretch=1)
        self.refresh_button = QPushButton("刷新")
        self.refresh_button.clicked.connect(self.refresh)
        header.addWidget(self.refresh_button)
        self.open_folder_button = QPushButton("打开资料目录")
        self.open_folder_button.clicked.connect(self.open_reports_folder)
        header.addWidget(self.open_folder_button)
        layout.addLayout(header)

        stats = QHBoxLayout()
        self.pending_label = QLabel("待审阅 0")
        self.pending_label.setObjectName("diagnosticPending")
        stats.addWidget(self.pending_label)
        self.total_label = QLabel("共 0 条")
        self.total_label.setObjectName("mutedLabel")
        stats.addWidget(self.total_label)
        stats.addStretch()
        layout.addLayout(stats)

        content = QHBoxLayout()
        content.setSpacing(14)
        self.report_list = QListWidget()
        self.report_list.setObjectName("diagnosticList")
        self.report_list.setMinimumWidth(310)
        self.report_list.currentRowChanged.connect(self._show_report)
        content.addWidget(self.report_list, 2)
        self.details = QTextEdit()
        self.details.setObjectName("diagnosticDetails")
        self.details.setReadOnly(True)
        self.details.setPlaceholderText("选择一条异常样本查看详情")
        content.addWidget(self.details, 3)
        layout.addLayout(content, stretch=1)

    def refresh(self):
        selected_id = None
        row = self.report_list.currentRow()
        if 0 <= row < len(self._reports):
            selected_id = self._reports[row].sample_id
        self._reports = load_diagnostic_summaries(self.reports_root)
        self.report_list.clear()
        selected_row = 0
        pending = 0
        for index, report in enumerate(self._reports):
            status = "已审阅" if report.reviewed else "待审阅"
            if not report.reviewed:
                pending += 1
            category = "、".join(report.categories) or "未分类"
            duration = f"{report.duration_s:.1f} 秒" if report.duration_s else "时长未知"
            item = QListWidgetItem(
                f"{status}  ·  {category}\n{report.sample_id}  ·  {duration}")
            item.setData(Qt.ItemDataRole.UserRole, report.sample_id)
            item.setForeground(QColor("#f0b7de" if not report.reviewed else "#d6d9e1"))
            self.report_list.addItem(item)
            if report.sample_id == selected_id:
                selected_row = index
        self.pending_label.setText(f"待审阅 {pending}")
        self.total_label.setText(f"共 {len(self._reports)} 条")
        self.pending_count_changed.emit(pending)
        if self._reports:
            self.report_list.setCurrentRow(selected_row)
        else:
            self.details.clear()
            self.details.setPlaceholderText("还没有已提交的异常样本")

    def open_reports_folder(self):
        self.reports_root.mkdir(parents=True, exist_ok=True)
        QDesktopServices.openUrl(QUrl.fromLocalFile(str(self.reports_root)))

    def _show_report(self, row: int):
        if row < 0 or row >= len(self._reports):
            self.details.clear()
            return
        report = self._reports[row]
        lines = [
            f"样本编号\n{report.sample_id}",
            f"状态\n{'已审阅' if report.reviewed else '等待自动审阅'}",
            f"异常类型\n{'、'.join(report.categories) or '未分类'}",
            f"用户备注\n{report.note or '无'}",
            f"音频\n{report.engine} · {report.duration_s:.1f} 秒",
        ]
        if report.verdict:
            lines.append(f"审阅结论\n{report.verdict}")
        if report.findings:
            lines.append("关键发现\n" + "\n".join(
                f"• {value}" for value in report.findings))
        if report.next_experiments:
            lines.append("下一步实验\n" + "\n".join(
                f"• {value}" for value in report.next_experiments))
        lines.append(f"资料目录\n{report.folder}")
        self.details.setPlainText("\n\n".join(lines))
