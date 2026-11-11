#!/usr/bin/env python3
"""
静态图按「实际显示尺寸」重压（手动执行，产物入库）。

## 为什么必须原地重编码、绝不改文件名

  - `/avatars/N.png`、`/emoicon/N.png` 不只被源码引用，还**写进了已发表帖子的正文 HTML**
    （`<img src="/emoicon/12.png" class="em_icon">`，见 apps/web/src/components/Composer.tsx），
    改名会让历史内容全部变成裂图；
  - 因此 `public/_headers` 里的 `immutable` 也一并保留：回访者手里已有旧图（零请求、零浪费），
    新访客拿到的是重压后的版本 —— 不存在「改了图反而更慢」的回退路径。

## 尺寸规则的来源

规则是「实际渲染尺寸 × 2（DPR）」向上取整，不是拍脑袋的全站统一值：

  | 文件 | 原尺寸 | 显示尺寸 | 目标宽度 |
  |---|---|---|---|
  | theme-light/bg-0.webp | 1200×288 | 80px 高的装饰条（≤640 宽） | 1000 |
  | theme-light/login_bg.webp | 750×1300 | 登录卡左栏（≈450 宽） | 750（仅降质） |
  | theme-light/login_top_bg.webp | 1200×1200 | 400×400 装饰 | 600 |
  | theme-light/itemBg1/3.webp | 1200×~400 | 发现页卡头（≈370 宽） | 800 |
  | avatars/*.png | 240×240 | `size-8`/`size-10`，个人页 80px | 160 |
  | emoicon/*.png | 未知 | 表情面板 `size-6`（24px） | 48 |

改主题版式、或图片显示尺寸变化后重跑本脚本；只写回「变小了」的文件。

用法：
    python scripts/optimize-images.py            # 执行
    python scripts/optimize-images.py --dry-run  # 只报告，不落盘
"""

from __future__ import annotations

import glob
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUB = os.path.join(ROOT, 'apps/web/public')

# (glob 相对 public, 目标最大宽度, 输出格式, webp 质量)
RULES = [
    ('theme-light/bg-0.webp', 1000, 'WEBP', 76),
    ('theme-light/login_bg.webp', 750, 'WEBP', 72),
    ('theme-light/login_top_bg.webp', 600, 'WEBP', 72),
    ('theme-light/itemBg1.webp', 800, 'WEBP', 72),
    ('theme-light/itemBg3.webp', 800, 'WEBP', 72),
    ('avatars/*.png', 160, 'PNG', None),
    ('emoicon/*.png', 48, 'PNG', None),
]

kb = lambda n: f'{n / 1024:8.1f} KB'


def encode(img: Image.Image, fmt: str, quality: int | None) -> bytes:
    import io

    buf = io.BytesIO()
    if fmt == 'WEBP':
        img.save(buf, format='WEBP', quality=quality, method=6)
    else:
        # PNG：先量化到 128 色调色板（FASTOCTREE 保留 alpha）再存。
        # 头像/表情都是扁平插画，直接存 RGBA 反而更大 —— 实测 57 个头像
        # 160×160 RGBA 是 729KB，量化后 179KB（-76%），肉眼无差。
        img.convert('RGBA').quantize(128, method=Image.FASTOCTREE).save(buf, format='PNG', optimize=True)
    return buf.getvalue()


def main() -> int:
    dry = '--dry-run' in sys.argv
    total_before = total_after = 0
    changed = skipped = 0
    print(f'{"文件":42} {"原尺寸":>11} {"新尺寸":>11}  {"前":>10} {"后":>10}')
    print('-' * 92)

    for pattern, max_w, fmt, quality in RULES:
        for path in sorted(glob.glob(os.path.join(PUB, pattern))):
            rel = os.path.relpath(path, PUB)
            before = os.path.getsize(path)
            with Image.open(path) as img:
                w, h = img.size
                if w > max_w:
                    new_h = max(1, round(h * max_w / w))
                    img = img.resize((max_w, new_h), Image.LANCZOS)
                else:
                    new_h = h
                data = encode(img, fmt, quality)

            total_before += before
            if len(data) >= before:
                total_after += before
                skipped += 1
                continue
            total_after += len(data)
            changed += 1
            if not dry:
                with open(path, 'wb') as f:
                    f.write(data)

            # 目录内文件很多时只打印有变化的，避免刷屏
            if pattern.startswith(('avatars', 'emoicon')):
                continue
            print(f'{rel:42} {f"{w}x{h}":>11} {f"{min(w, max_w)}x{new_h}":>11}  {kb(before)} {kb(len(data))}')

    print('-' * 92)
    print(
        f'合计：{kb(total_before)} → {kb(total_after)}'
        f'（-{(1 - total_after / total_before) * 100:.0f}%），改写 {changed} 个，跳过 {skipped} 个（未变小）'
        + ('　[dry-run，未落盘]' if dry else '')
    )
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
