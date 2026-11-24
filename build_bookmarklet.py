# -*- coding: utf-8 -*-
"""把 userscript 构建为「书签版」，保证两版逻辑来自同一份源码。

用法:
    python build_bookmarklet.py
    python build_bookmarklet.py --src agent-element-inspector.user.js --out dist/aei-bookmarklet.html
"""
import argparse
import html
import re
import sys
from pathlib import Path
from urllib.parse import quote

META_RE = re.compile(r"//\s*==UserScript==.*?//\s*==/UserScript==\s*", re.S)


def strip_metadata(source: str) -> str:
    """去掉 Tampermonkey 元信息块，书签版不需要。"""
    return META_RE.sub("", source, count=1).strip()


def compact_source(source: str) -> str:
    """压缩为单行：去行首缩进与空行，保留字符串内部空白。"""
    lines = []
    for line in source.splitlines():
        if not line.strip():
            continue
        lines.append(line.strip() if line.lstrip().startswith("//") else line)
    return "\n".join(lines)


def build_bookmarklet(source: str) -> str:
    code = compact_source(strip_metadata(source))
    if not code:
        raise ValueError("源码为空，无法构建")
    return "javascript:" + quote(code, safe="")


def build_html(bookmarklet: str, version: str) -> str:
    label = html.escape(bookmarklet, quote=True)
    size_kb = len(bookmarklet.encode("utf-8")) / 1024
    warning = ""
    if size_kb > 100:
        warning = (
            '<p class="warn">当前书签长度约 %.0f KB，部分浏览器会截断超长书签；'
            "建议优先使用 Tampermonkey 版。</p>" % size_kb
        )
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>网页元素选择器 · 书签版</title>
<style>
  body {{ font: 14px/1.7 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; margin: 40px auto; max-width: 720px; color: #1c2430; }}
  h1 {{ font-size: 20px; }}
  a.bookmark {{ display: inline-block; padding: 10px 20px; background: #1f6feb; color: #fff; border-radius: 8px; text-decoration: none; font-weight: 700; }}
  code {{ background: #f1f4f9; padding: 1px 5px; border-radius: 4px; }}
  .warn {{ color: #b42318; }}
  .tip {{ color: #5d6b7d; font-size: 12.5px; }}
</style>
</head>
<body>
<h1>网页元素选择器（Agent Element Inspector）· 书签版 v{html.escape(version)}</h1>
<p>把下面的按钮拖到浏览器书签栏，在目标页面点击即可启动。书签版不支持 <code>@grant</code> 相关能力，功能与 userscript 主体一致。</p>
<p><a class="bookmark" href="{label}">AEI 元素选择器</a></p>
{warning}
<p class="tip">书签长度约 {size_kb:.1f} KB。源码与 Tampermonkey 版同源，由 build_bookmarklet.py 生成，请勿手工修改本文件。</p>
</body>
</html>
"""


def main() -> int:
    parser = argparse.ArgumentParser(description="构建 AEI 书签版")
    parser.add_argument("--src", default="agent-element-inspector.user.js")
    parser.add_argument("--out", default="dist/aei-bookmarklet.html")
    args = parser.parse_args()

    src_path = Path(args.src).resolve()
    if not src_path.exists():
        print(f"源码不存在: {src_path}", file=sys.stderr)
        return 1
    source = src_path.read_text(encoding="utf-8")

    version_match = re.search(r"@version\s+([\w.\-]+)", source)
    version = version_match.group(1) if version_match else "0.0.0"

    bookmarklet = build_bookmarklet(source)
    out_path = Path(args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(build_html(bookmarklet, version), encoding="utf-8")

    print(f"已生成: {out_path}")
    print(f"版本: {version}  书签长度: {len(bookmarklet.encode('utf-8')) / 1024:.1f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
