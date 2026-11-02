import shutil
import sys
from collections import Counter

import pytesseract
from PIL import Image, ImageChops, ImageOps

DEFAULT_TESSERACT = r"C:\Program Files\Tesseract-OCR\tesseract.exe"
ALLOWED_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
CAPTCHA_LEN = 6
DARK_THRESHOLDS = (50, 70, 90, 110, 130)
PSMS = (7, 8, 13)

if not shutil.which("tesseract"):
    pytesseract.pytesseract.tesseract_cmd = DEFAULT_TESSERACT


def preprocess(path, threshold):
    # captcha glyphs are near-black, the noise lines are coloured/lighter: keep only
    # near-black pixels, add a white margin (edge chars get dropped), then upscale
    r, g, b = Image.open(path).convert("RGB").split()
    darkest = ImageChops.lighter(ImageChops.lighter(r, g), b)  # per-pixel max channel
    img = darkest.point([0 if v < threshold else 255 for v in range(256)])
    img = ImageOps.expand(img, border=10, fill=255)
    return img.resize((img.width * 4, img.height * 4), Image.Resampling.LANCZOS)


def solve(path):
    """Try every threshold/psm combo; vote among reads that are CAPTCHA_LEN long."""
    reads = []
    for threshold in DARK_THRESHOLDS:
        img = preprocess(path, threshold)
        for psm in PSMS:
            config = f"--psm {psm} -c tessedit_char_whitelist={ALLOWED_CHARS}"
            text = pytesseract.image_to_string(img, config=config).strip()
            if text:
                reads.append(text)

    valid = Counter(t for t in reads if len(t) == CAPTCHA_LEN)
    if valid:
        return valid.most_common(1)[0][0], reads
    return None, reads


def main():
    # if len(sys.argv) < 2:
    #     print("usage: python ocr_test.py <image_path>")
    #     sys.exit(1)

    # path = sys.argv[1]
    path = r'C:\Users\verve\Desktop\test\automation\image.png'

    text, reads = solve(path)
    if text is None:
        print(f"no {CAPTCHA_LEN}-char read, got: {Counter(reads).most_common()}", file=sys.stderr)
        sys.exit(1)

    print(text)
    if "--debug" in sys.argv:
        print(Counter(reads).most_common(), file=sys.stderr)


if __name__ == "__main__":
    main()
