"""生成 build/icon.ico —— 圆角渐变底 + 白色钢笔尖。"""
from PIL import Image, ImageDraw
import math, os

S = 1024
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

# 渐变底
grad = Image.new("RGB", (S, S))
gd = grad.load()
c1 = (37, 99, 235)    # #2563eb
c2 = (124, 58, 237)   # #7c3aed
for y in range(S):
    for x in range(S):
        t = (x / S * 0.55 + y / S * 0.45)
        gd[x, y] = (
            int(c1[0] + (c2[0] - c1[0]) * t),
            int(c1[1] + (c2[1] - c1[1]) * t),
            int(c1[2] + (c2[2] - c1[2]) * t),
        )

# 圆角遮罩
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=255)
img.paste(grad, (0, 0), mask)

d = ImageDraw.Draw(img)

# 白色钢笔尖（朝下）
cx = S / 2
top = S * 0.20
bottom = S * 0.80
half = S * 0.21
nib = [
    (cx, bottom),                     # 笔尖
    (cx - half, S * 0.46),            # 左肩
    (cx - half, top + S * 0.06),
    (cx, top),                        # 顶
    (cx + half, top + S * 0.06),
    (cx + half, S * 0.46),            # 右肩
]
d.polygon(nib, fill=(255, 255, 255, 255))

# 笔尖中缝
d.line([(cx, S * 0.52), (cx, S * 0.74)], fill=(37, 99, 235, 255), width=int(S * 0.045))
# 呼吸孔
r = S * 0.045
d.ellipse([cx - r, S * 0.44 - r, cx + r, S * 0.44 + r], fill=(37, 99, 235, 255))

os.makedirs("build", exist_ok=True)
sizes = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)]
img.save("build/icon.ico", sizes=sizes)
img.resize((512, 512), Image.LANCZOS).save("build/icon.png")
print("wrote build/icon.ico", os.path.getsize("build/icon.ico"), "bytes")
