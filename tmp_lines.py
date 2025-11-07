from pathlib import Path
text = Path(''pages/stage2/stats.js'').read_text().splitlines()
for idx,line in enumerate(text,1):
    if 'pageInput' in line:
        print('pageInput', idx, line.strip())
    if 'handlePageJump' in line:
        print('handlePageJump', idx, line.strip())
    if '<div className="pagination"' in line:
        print('pagination', idx)
