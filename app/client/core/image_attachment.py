"""聊天图片的本地预处理边界。"""
from __future__ import annotations

import base64
from pathlib import Path

from PyQt6.QtCore import QByteArray, QBuffer, QIODevice, Qt
from PyQt6.QtGui import QColor, QImage, QImageReader, QPainter


MAX_IMAGE_EDGE = 1600
MAX_IMAGE_BYTES = 4 * 1024 * 1024


def prepare_chat_image(path, max_edge=MAX_IMAGE_EDGE,
                       max_bytes=MAX_IMAGE_BYTES):
    """读取、纠正方向并压缩图片，返回网络载荷和界面元数据。"""
    source = Path(path)
    reader = QImageReader(str(source))
    reader.setAutoTransform(True)
    image = reader.read()
    if image.isNull():
        detail = reader.errorString() or "无法解码"
        raise ValueError(f"无法读取图片：{detail}")

    payload, metadata = encode_chat_image(image, max_edge, max_bytes)
    metadata.update(path=str(source), name=source.name)
    return payload, metadata


def encode_chat_image(image, max_edge=MAX_IMAGE_EDGE, max_bytes=MAX_IMAGE_BYTES):
    """Encode a decoded raster, also used for PDF page previews."""

    if max(image.width(), image.height()) > max_edge:
        image = image.scaled(
            max_edge, max_edge,
            Qt.AspectRatioMode.KeepAspectRatio,
            Qt.TransformationMode.SmoothTransformation,
        )

    # JPEG 不支持透明通道；铺白底后再编码，避免透明区域变黑。
    flattened = QImage(image.size(), QImage.Format.Format_RGB32)
    flattened.fill(QColor("white"))
    painter = QPainter(flattened)
    painter.drawImage(0, 0, image)
    painter.end()

    encoded = None
    for quality in (88, 78, 68, 58):
        byte_array = QByteArray()
        buffer = QBuffer(byte_array)
        if not buffer.open(QIODevice.OpenModeFlag.WriteOnly):
            raise ValueError("无法创建图片编码缓冲区")
        ok = flattened.save(buffer, "JPEG", quality)
        buffer.close()
        if not ok:
            raise ValueError("无法编码图片")
        candidate = bytes(byte_array)
        if len(candidate) <= max_bytes:
            encoded = candidate
            break
    if encoded is None:
        raise ValueError("图片压缩后仍超过 4 MB，请选择较小的图片")

    payload = {
        "type": "image",
        "data": base64.b64encode(encoded).decode("ascii"),
        "mimeType": "image/jpeg",
    }
    metadata = {
        "width": flattened.width(),
        "height": flattened.height(),
        "bytes": len(encoded),
    }
    return payload, metadata
