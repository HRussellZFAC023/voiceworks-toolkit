import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { JSDOM } from 'jsdom';
import { parseDlsiteHtml } from '../../src/scrapers/dlsite';

describe('DLsite Scraper Selectors', () => {
    let document: Document;

    beforeEach(() => {
        const html = fs.readFileSync(path.resolve(__dirname, '../fixtures/dlsite_dummy.html'), 'utf8');
        const dom = new JSDOM(html);
        document = dom.window.document;
    });

    it('should find table#work_maker', () => {
        const table = document.querySelector('table#work_maker');
        expect(table).toBeTruthy();
    });

    it('should extract voice actors', () => {
        const ths = Array.from(document.querySelectorAll('table#work_maker th'));
        const vaTh = ths.find(th => th.textContent?.includes('Voice Actor'));
        expect(vaTh).toBeTruthy();
        const td = vaTh?.nextElementSibling;
        const links = td?.querySelectorAll('a');
        expect(links?.length).toBe(2);
        expect(links?.[0].textContent).toBe('Test CV 1');
    });

    it('should find .main_genre', () => {
        const genre = document.querySelector('.main_genre');
        expect(genre).toBeTruthy();
        expect(genre?.textContent).toBe('Ear Cleaning');
    });

    it('should parse series and distinguish voice actors from authors', () => {
        const html = fs.readFileSync(path.resolve(__dirname, '../fixtures/dlsite_dummy.html'), 'utf8');
        const parsed = parseDlsiteHtml(html);

        expect(parsed.series?.name).toBe('Test Series');
        expect(parsed.series?.id).toBe(12345678);
        expect(parsed.voiceActors.map(va => va.name)).toEqual(['Test CV 1', 'Test CV 2']);
        expect(parsed.authors.map(a => a.name)).toEqual(['Test Author']);
    });
});
