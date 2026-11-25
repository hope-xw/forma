"""Extract traceable research records. Requires PyMuPDF; never executes PDF content."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import pymupdf

ENTRY = re.compile(r'^(F\d{2}|(?:MG|ARD|COD|PAP|PEN|JS)-\d{2}) (.+)$', re.M)
EXPECTED = {'F': 77, 'MG': 42, 'ARD': 34, 'COD': 5, 'PAP': 8, 'PEN': 8, 'JS': 8}


def extract(source: Path) -> dict:
    document = pymupdf.open(source)
    records = []
    for page_index, page in enumerate(document):
        text = page.get_text()
        matches = list(ENTRY.finditer(text))
        for index, match in enumerate(matches):
            body = text[match.end():matches[index + 1].start() if index + 1 < len(matches) else len(text)].strip()
            records.append({'id': match[1], 'title': match[2], 'page': page_index + 1,
                            'researchText': body, 'sourceIds': re.findall(r'SRC-\d{3}', body),
                            'implementationStatus': 'not_started', 'acceptanceStatus': 'not_defined'})
    ids = [record['id'] for record in records]
    assert len(ids) == len(set(ids)) == 182, 'Missing or duplicate research records'
    for prefix, count in EXPECTED.items():
        actual = sum(bool(re.fullmatch(prefix + (r'\d{2}' if prefix == 'F' else r'-\d{2}'), value)) for value in ids)
        assert actual == count, (prefix, actual, count)
    return {'sourceFile': source.name, 'sha256': hashlib.sha256(source.read_bytes()).hexdigest(),
            'pages': len(document), 'researchAsOf': '2026-11-06',
            'notice': 'PDF research is evidence, not approved scope or proof of implementation. Vendor claims have not been independently retested.',
            'requirements': records}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    result = extract(args.source)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(f"Extracted and validated {len(result['requirements'])} records from {result['pages']} pages")
