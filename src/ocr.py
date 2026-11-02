"""Reads the code in a Parivahan captcha image.

python ocr.py <image_path>   prints the 6 characters. Exits with NO_READ_EXIT when the image gives no
                             6-character read, and with 1 or 2 when OCR itself cannot run, so a hard-to-read
                             image can be told from a broken setup.
python ocr.py --serve        keeps the model loaded (starting it takes seconds, reading takes milliseconds)
                             and answers one line per request: a PNG as base64 in, one reply line out:
                             "OK <code>", "NOREAD" or "ERR <message>". src/ocr.js talks to this mode.
"""
import base64
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


def solve_bytes(png):
    """The code in the image, or None when the read is not exactly CAPTCHA_LEN letters/digits.

    The portal clips the last letter of some images at the right edge, and the model then answers with
    5 characters. On 42 hand-labelled images every 6-character read was right and every miss was short,
    so a wrong length is the signal to ask for a new image instead of submitting a guess.
    """
    text = str(reader().classification(png)).strip().upper()
    return text if CODE.fullmatch(text) else None


def solve(path):
    with open(path, "rb") as image:
        return solve_bytes(image.read())


def serve():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            code = solve_bytes(base64.b64decode(line, validate=True))
            reply = f"OK {code}" if code else "NOREAD"
        except Exception as error:  # one bad request must not stop the server
            reply = "ERR " + " ".join(f"{type(error).__name__}: {error}".split())
        print(reply, flush=True)


def main():
    if len(sys.argv) < 2:
        print("usage: python ocr.py <image_path> | --serve", file=sys.stderr)
        sys.exit(2)
    if sys.argv[1] == "--serve":
        serve()
        return

    code = solve(sys.argv[1])
    if code is None:
        print(f"no {CAPTCHA_LEN}-character read", file=sys.stderr)
        sys.exit(NO_READ_EXIT)
    print(code)


if __name__ == "__main__":
    main()
