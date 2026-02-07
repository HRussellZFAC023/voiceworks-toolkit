export interface DlsitePerson {
    name: string;
    id?: number | string;
}

export interface DlsiteSeries {
    id?: number;
    name: string;
}

export interface DlsiteScrapeResult {
    series?: DlsiteSeries;
    voiceActors: DlsitePerson[];
    authors: DlsitePerson[];
}

const HEADER_MATCHERS = {
    voice: [/voice actor/i, /voice/i, /声優/, /聲優/],
    author: [/author/i, /writer/i, /原作/, /著者/],
    series: [/series/i, /シリーズ/, /系列/]
};

export function parseDlsiteHtml(html: string): DlsiteScrapeResult {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const result: DlsiteScrapeResult = { voiceActors: [], authors: [] };

    const series = findSeries(doc);
    if (series) result.series = series;

    const table = doc.querySelector('table#work_maker');
    if (!table) return result;

    const rows = Array.from(table.querySelectorAll('tr'));
    rows.forEach(row => {
        const th = row.querySelector('th');
        const td = row.querySelector('td');
        if (!th || !td) return;

        const label = (th.textContent || '').trim();
        if (matches(label, HEADER_MATCHERS.voice)) {
            result.voiceActors = extractPeople(td);
        } else if (matches(label, HEADER_MATCHERS.author)) {
            result.authors = extractPeople(td);
        }
    });

    return result;
}

function findSeries(doc: Document): DlsiteSeries | undefined {
    const rows = Array.from(doc.querySelectorAll('table tr')) as HTMLTableRowElement[];
    for (const row of rows) {
        const th = row.querySelector('th');
        const td = row.querySelector('td');
        if (!th || !td) continue;
        const label = (th.textContent || '').trim();
        if (!matches(label, HEADER_MATCHERS.series)) continue;
        const anchor = td.querySelector('a');
        const name = (anchor?.textContent || td.textContent || '').trim();
        if (!name) continue;
        const href = anchor?.getAttribute('href') || '';
        const match = href.match(/SRI(\d{6,10})/i);
        return { id: match ? Number(match[1]) : undefined, name };
    }
    return undefined;
}

function extractPeople(td: Element): DlsitePerson[] {
    const links = Array.from(td.querySelectorAll('a')) as HTMLAnchorElement[];
    if (links.length === 0) {
        const text = (td.textContent || '').trim();
        return text ? [{ name: text }] : [];
    }

    return links.map(link => ({ name: (link.textContent || '').trim() })).filter(p => p.name);
}

function matches(label: string, patterns: RegExp[]): boolean {
    return patterns.some(p => p.test(label));
}
