# -*- coding: utf-8 -*-
"""只读音频可视化分析：把 PCM 块转换为归一化对数频带。"""
import numpy as np


def spectrum_bands(audio, sample_rate, band_count=96):
    """返回 0–1 频谱数组；不会修改输入音频。"""
    samples = np.asarray(audio, dtype=np.float32).reshape(-1)
    if samples.size < 16 or not np.any(samples):
        return np.zeros(band_count, dtype=np.float32)

    windowed = samples * np.hanning(samples.size).astype(np.float32)
    magnitude = np.abs(np.fft.rfft(windowed))
    frequencies = np.fft.rfftfreq(samples.size, 1.0 / float(sample_rate))
    upper = min(float(sample_rate) / 2.0, 12000.0)
    if upper <= 55.0:
        return np.zeros(band_count, dtype=np.float32)

    # 人耳感知更接近对数频率；55Hz–Nyquist 映射到环形的 96 根柱。
    edges = np.geomspace(55.0, upper, band_count + 1)
    result = np.zeros(band_count, dtype=np.float32)
    for index in range(band_count):
        mask = (frequencies >= edges[index]) & (frequencies < edges[index + 1])
        if np.any(mask):
            result[index] = float(np.sqrt(np.mean(magnitude[mask] ** 2)))

    peak = float(result.max())
    if peak > 1e-10:
        # 频谱形状按本帧峰值归一，整体高度仍由真实 RMS 控制。
        result /= peak
    rms = float(np.sqrt(np.mean(samples ** 2)))
    envelope = min(1.0, np.sqrt(max(0.0, rms / 0.05)))
    result = np.sqrt(result) * envelope
    return np.clip(result, 0.0, 1.0).astype(np.float32)
