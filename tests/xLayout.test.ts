// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mountSpeakerButton, extractTweetText, registerPlayHandler } from '../src/ui/speakerButton';
import { SELECTORS } from '../src/x/selectors';

function modernPost(body: string, header = true): HTMLElement {
  const article = document.createElement('article');
  article.innerHTML = `
    ${header ? '<div class="actions"><span><button aria-label="Explain this post"></button></span><button><svg><use href="#icon-more-dots-hor"></use></svg></button></div>' : ''}
    ${body}
    <div class="engagement"><div data-engagement-action="reply"><a href="/compose/post?in_reply_to=1">Reply</a></div><div data-engagement-action="like"></div><div data-engagement-action="bookmark"></div></div>`;
  document.body.append(article);
  return article;
}

const modernText = (text: string) => `<div dir="auto" class="max-w-full whitespace-pre-wrap wrap-break-word"><span>${text}</span></div>`;

describe('current X post layout', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.stubGlobal('localStorage', { getItem: () => '1', setItem: () => {} });
  });

  it('finds text, mounts next to header actions and plays it once', async () => {
    const article = modernPost(modernText('A post with words.'));
    const play = vi.fn();
    registerPlayHandler(play);
    expect(document.querySelectorAll(SELECTORS.tweet)).toHaveLength(1);
    expect(extractTweetText(article)).toBe('A post with words.');
    mountSpeakerButton(article);
    mountSpeakerButton(article);
    expect(article.querySelectorAll('.ttsx-speaker-btn')).toHaveLength(1);
    expect(article.querySelector('.actions')?.firstElementChild?.classList.contains('ttsx-action')).toBe(true);
    article.querySelector<HTMLButtonElement>('.ttsx-speaker-btn')!.click();
    await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    expect(play.mock.calls[0]?.[0]).toBe('A post with words.');
  });

  it('uses the engagement row when a header is absent', () => {
    const article = modernPost(modernText('A reply.'), false);
    mountSpeakerButton(article);
    expect(article.querySelector('.engagement .ttsx-speaker-btn')).not.toBeNull();
  });

  it('never reads a quoted post as the parent post', () => {
    const quote = `<div role="link" data-href="/other/status/42">${modernText('Quoted words.')}</div>`;
    const article = modernPost(modernText('Original words.') + quote);
    expect(extractTweetText(article)).toBe('Original words.');
    const quoteOnly = modernPost(quote);
    mountSpeakerButton(quoteOnly);
    expect(extractTweetText(quoteOnly)).toBe('');
    expect(quoteOnly.querySelector('.ttsx-speaker-btn')).toBeNull();
  });

  it('keeps legacy posts readable', () => {
    const article = document.createElement('article');
    article.dataset.testid = 'tweet';
    article.innerHTML = '<div data-testid="tweetText">Legacy post.</div><div role="group"><button data-testid="reply"></button></div>';
    document.body.append(article);
    mountSpeakerButton(article);
    expect(extractTweetText(article)).toBe('Legacy post.');
    expect(article.querySelector('.ttsx-speaker-btn')).not.toBeNull();
  });
});
