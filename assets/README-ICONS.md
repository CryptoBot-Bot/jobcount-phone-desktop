# Icons

The source of truth is `icon.svg`. Platform-specific icon files are needed
for packaging; generate them once with any tool you prefer. Recommended:

- **Windows**: `icon.ico` — use [ImageMagick](https://imagemagick.org/) or
  [RealFaviconGenerator](https://realfavicongenerator.net/):
  ```
  magick convert -density 384 icon.svg -define icon:auto-resize=256,128,64,48,32,16 icon.ico
  ```
- **macOS**: `icon.icns` — use [`png2icns`](https://formulae.brew.sh/formula/libicns)
  or Icon Composer:
  ```
  magick convert -background none icon.svg -resize 1024x1024 icon-1024.png
  png2icns icon.icns icon-1024.png
  ```
- **Linux**: `icon.png` — 512x512 recommended:
  ```
  magick convert -background none -density 384 icon.svg -resize 512x512 icon.png
  ```

### Tray icon

`tray-icon.png` should be a 16x16 (or 32x32 on hi-DPI) PNG with transparent
background. A simple glyph of the phone mark with plain white fill works
best — color gradients don't render well at small sizes.

Until you generate these, the app falls back to Electron's default
application icon and a blank tray slot (the tray still works — just no
custom glyph).
