"""Reads the code in a Parivahan captcha image: python ocr.py <image_path>

Prints the 6 characters. Exits with NO_READ_EXIT when the image gives no 6-character read, and with
1 or 2 when OCR itself cannot run, so src/ocr.js can tell a hard-to-read image from a broken setup.
"""
import contextlib
import re
import sys

CAPTCHA_LEN = 6
NO_READ_EXIT = 3
CODE = re.compile(rf"[A-Z0-9]{{{CAPTCHA_LEN}}}")

# ddddocr prints while it loads; stdout is kept for the answer alone.
try:
    with contextlib.redirect_stdout(sys.stderr):
        import ddddocr
except ImportError:
    print("ddddocr is not installed. Run: pip install ddddocr", file=sys.stderr)
    sys.exit(1)

_reader = None


def reader():
    global _reader
    if _reader is None:
        with contextlib.redirect_stdout(sys.stderr):
            _reader = ddddocr.DdddOcr(show_ad=False)
    return _reader


def solve(path):
    """The code in the image, or None when the read is not exactly CAPTCHA_LEN letters/digits.

    The portal clips the last letter of some images at the right edge, and the model then answers with
    5 characters. On 42 hand-labelled images every 6-character read was right and every miss was short,
    so a wrong length is the signal to ask for a new image instead of submitting a guess.
    """
    with open(path, "rb") as image:
        text = str(reader().classification(image.read())).strip().upper()
    return text if CODE.fullmatch(text) else None


def main():
    if len(sys.argv) < 2:
        print("usage: python ocr.py <image_path>", file=sys.stderr)
        sys.exit(2)

    code = solve(sys.argv[1])
    if code is None:
        print(f"no {CAPTCHA_LEN}-character read", file=sys.stderr)
        sys.exit(NO_READ_EXIT)
    print(code)


if __name__ == "__main__":
    main()
