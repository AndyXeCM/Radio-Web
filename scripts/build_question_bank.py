#!/usr/bin/env python3
"""Build the shared CRAC 2025 amateur radio question bank JSON.

The official PDFs are already structured with bracket tags:
  [J] source item id
  [P] knowledge point
  [I] item code / choice count
  [Q] question
  [T] correct answer letters
  [A-D] choices
  [F] figure filename
"""

from __future__ import annotations

import json
import re
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

from pypdf import PdfReader


ROOT = Path(__file__).resolve().parents[1]
RAW_DIR = ROOT / "data" / "raw"
OUT_DIR = ROOT / "data" / "processed"

SOURCES = {
    "A": {
        "title": "CRAC 2025 A类业余无线电台操作技术能力验证题库",
        "pdf": RAW_DIR / "crac_2025_a.pdf",
        "url": "http://www.crac.org.cn/userfiles/file/20250809/20250809124220_1161.pdf",
    },
    "B": {
        "title": "CRAC 2025 B类业余无线电台操作技术能力验证题库",
        "pdf": RAW_DIR / "crac_2025_b.pdf",
        "url": "http://www.crac.org.cn/userfiles/file/20250809/20250809124234_5845.pdf",
    },
    "C": {
        "title": "CRAC 2025 C类业余无线电台操作技术能力验证题库",
        "pdf": RAW_DIR / "crac_2025_c.pdf",
        "url": "http://www.crac.org.cn/userfiles/file/20250809/20250809124246_6142.pdf",
    },
}

TOPIC_MAP = {
    "1": "法规与电台管理",
    "2": "通联操作与国际规则",
    "3": "设备、天馈与传播",
    "4": "电子电路与测量",
    "5": "发射设备指标",
}

TAG_TO_FIELD = {
    "J": "officialId",
    "P": "point",
    "I": "itemCode",
    "Q": "question",
    "T": "answer",
    "A": "A",
    "B": "B",
    "C": "C",
    "D": "D",
    "F": "figure",
}


def extract_text(pdf_path: Path) -> str:
    reader = PdfReader(str(pdf_path))
    return "\n".join((page.extract_text() or "") for page in reader.pages)


def normalize(parts: list[str]) -> str:
    clean_parts = []
    for part in parts:
        text = part.strip()
        if not text:
            continue
        if re.fullmatch(r"\d{1,4}", text):
            continue
        clean_parts.append(text)
    text = "".join(clean_parts)
    text = re.sub(r"[ \t]+", " ", text)
    return text.strip()


def finish_question(raw: dict[str, list[str] | str], level: str) -> dict:
    official_id = normalize(raw.get("officialId", []))
    point = normalize(raw.get("point", []))
    item_code = normalize(raw.get("itemCode", []))
    answer = normalize(raw.get("answer", [])).replace(" ", "")
    major = point.split(".", 1)[0] if point else "0"
    choices = {
        key: normalize(raw.get(key, []))
        for key in ("A", "B", "C", "D")
    }
    answer_letters = [letter for letter in answer if letter in choices]

    stem = item_code.split("-", 1)[0] if "-" in item_code else item_code
    choice_count = 1
    match = re.search(r"MC(\d+)", stem)
    if match:
        choice_count = int(match.group(1))

    return {
        "id": f"{level}-{item_code}",
        "level": level,
        "officialId": official_id,
        "point": point,
        "topic": TOPIC_MAP.get(major, "综合知识"),
        "topicMajor": major,
        "itemCode": item_code,
        "type": "multiple" if choice_count > 1 or len(answer_letters) > 1 else "single",
        "choiceCount": choice_count,
        "question": normalize(raw.get("question", [])),
        "choices": choices,
        "answer": answer_letters,
        "figure": normalize(raw.get("figure", [])) or None,
        "sourceUrl": SOURCES[level]["url"],
    }


def parse_questions(level: str, text: str) -> list[dict]:
    questions: list[dict] = []
    current: dict[str, list[str]] | None = None
    active_field: str | None = None

    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue

        tag_match = re.match(r"^\[([A-Z])\](.*)$", stripped)
        if tag_match:
            tag, value = tag_match.groups()
            field = TAG_TO_FIELD.get(tag)
            if not field:
                active_field = None
                continue

            if tag == "J":
                if current and current.get("question"):
                    questions.append(finish_question(current, level))
                current = defaultdict(list)

            if current is None:
                current = defaultdict(list)

            current[field].append(value.strip())
            active_field = field if tag in {"Q", "A", "B", "C", "D"} else None
            continue

        if current and active_field and not re.fullmatch(r"\d{1,4}", stripped):
            current[active_field].append(stripped)

    if current and current.get("question"):
        questions.append(finish_question(current, level))

    return questions


def build() -> dict:
    all_questions = []
    banks = {}

    for level, source in SOURCES.items():
        text = extract_text(source["pdf"])
        questions = parse_questions(level, text)
        all_questions.extend(questions)

        topic_counts = Counter(question["topicMajor"] for question in questions)
        figure_count = sum(1 for question in questions if question["figure"])
        multiple_count = sum(1 for question in questions if question["type"] == "multiple")

        banks[level] = {
            "title": source["title"],
            "level": level,
            "count": len(questions),
            "multipleCount": multiple_count,
            "figureCount": figure_count,
            "sourceUrl": source["url"],
            "topics": {
                key: {
                    "name": TOPIC_MAP.get(key, "综合知识"),
                    "count": topic_counts[key],
                }
                for key in sorted(topic_counts)
            },
        }

    return {
        "schemaVersion": 1,
        "generatedAt": date.today().isoformat(),
        "source": {
            "name": "CRAC 2025 新 A/B/C 类业余无线电题库",
            "detailUrl": "http://www.crac.org.cn/News/Detail?ID=d11def30d20d4d8fb12e08e7160e607d",
        },
        "topicMap": TOPIC_MAP,
        "banks": banks,
        "questions": all_questions,
    }


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    data = build()
    output = OUT_DIR / "question_bank.json"
    output.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    compact_output = OUT_DIR / "question_bank.compact.json"
    compact_output.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    print(f"Wrote {output}")
    for level, bank in data["banks"].items():
        print(
            f"{level}: {bank['count']} questions, "
            f"{bank['multipleCount']} multiple-choice, {bank['figureCount']} figures"
        )


if __name__ == "__main__":
    main()
