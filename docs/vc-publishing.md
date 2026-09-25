# Manual VC.ru publishing

VC.ru is a manual channel. Pubrick does not call VC.ru or infer that a post is
live. After approving its adaptation, use **Download package** in the channel's
result card. The ZIP contains:

- `article.html` — the reviewed title and the saved VC.ru adaptation (or the
  master body when no adaptation override exists), with HTML-escaped text;
- `images/*.jpg` — the article's saved inline images, fetched through the
  signed-in, organization-scoped media endpoint;
- `cover.jpg` — the saved cover, when one is attached; upload it as the VC.ru
  cover after reviewing it;
- `README.txt` — manual publishing steps and each image's saved paragraph
  position in the master article.

If the VC.ru text exactly matches the master body, `article.html` places images
after their saved paragraphs. If it differs, images appear in a separate section
after the adapted text. The package never guesses where an image belongs in
rewritten paragraphs. Review those placements on VC.ru before publishing.

The browser fetches the current saved image slots and rereads the article and
VC.ru adaptation on click. It refuses the package if another editor withdrew
the manual approval, or if any inline or cover JPEG cannot be fetched. A cover
also used as an inline image is fetched once and included at both paths in the
ZIP. No public media link is issued. After publishing on VC.ru, paste its public
URL into Pubrick and select **Record publication**. That receipt is self reported
and does not verify VC.ru state.
