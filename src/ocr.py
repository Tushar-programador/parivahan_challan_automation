import shutil
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

import pytesseract
from PIL import Image, ImageChops, ImageOps

DEFAULT_TESSERACT = r"C:\Program Files\Tesseract-OCR\tesseract.exe"
ALLOWED_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
CAPTCHA_LEN = 6
DARK_THRESHOLDS = (50, 70, 90, 110, 130)
PSMS = (7, 8, 13)
# Each read starts its own tesseract process (about a second on Windows), so run them side by side.
WORKERS = 8
# Exit status for "the image has no 6-character read". Any other failure (missing Tesseract, bad
# image) exits with 1 or 2, so src/ocr.js can tell a hard-to-read captcha from a broken setup.
NO_READ_EXIT = 3

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


def read(job):
    img, psm = job
    config = f"--psm {psm} -c tessedit_char_whitelist={ALLOWED_CHARS}"
    # the portal takes the code in capitals, so 'a' and 'A' are the same vote
    return pytesseract.image_to_string(img, config=config).strip().upper()


def solve(path):
    """Try every threshold/psm combo; vote among reads that are CAPTCHA_LEN long."""
    jobs = [(preprocess(path, threshold), psm) for threshold in DARK_THRESHOLDS for psm in PSMS]
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        reads = [text for text in pool.map(read, jobs) if text]  # map keeps job order, so ties vote the same way

    valid = Counter(t for t in reads if len(t) == CAPTCHA_LEN)
    if valid:
        return valid.most_common(1)[0][0], reads
    return None, reads


def main():
    if len(sys.argv) < 2:
        print("usage: python ocr.py <image_path> [--debug]", file=sys.stderr)
        sys.exit(2)

    path = sys.argv[1]

    text, reads = solve(path)
    if text is None:
        print(f"no {CAPTCHA_LEN}-char read, got: {Counter(reads).most_common()}", file=sys.stderr)
        sys.exit(NO_READ_EXIT)

    print(text)
    if "--debug" in sys.argv:
        print(Counter(reads).most_common(), file=sys.stderr)


if __name__ == "__main__":
    main()
