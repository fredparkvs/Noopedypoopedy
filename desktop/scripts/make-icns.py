# Builds assets/icon.icns from assets/icon-1024.png (needs Pillow).
import sys, os
from PIL import Image
assets = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets')
img = Image.open(os.path.join(assets, 'icon-1024.png')).convert('RGBA')
img.save(os.path.join(assets, 'icon.icns'), sizes=[(16, 16), (32, 32), (64, 64), (128, 128), (256, 256), (512, 512), (1024, 1024)])
back = Image.open(os.path.join(assets, 'icon.icns'))
print('icon.icns sizes:', sorted(back.info.get('sizes', [])))
