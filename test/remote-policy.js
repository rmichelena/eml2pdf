#!/usr/bin/env node
// Static URL policy enforcement (the same gate that context.route applies
// dynamically for the PDF, but applied to the HTML body so it also covers
// the markdown output path).
//
// Run: node test/remote-policy.js

import { filterRemoteUrlsForTest } from '../src/convert.js';

let fail = 0;
function check(label, cond, ctx = {}) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) {
    fail++;
    for (const [k, v] of Object.entries(ctx)) console.log(`  ${k}=`, v);
  }
}

// 1. loadRemoteImages=false: ALL http(s) URLs blocked, irrespective of host.
{
  const body = `<img src="https://1.1.1.1/logo.png" alt="logo">`;
  const warnings = [];
  const out = await filterRemoteUrlsForTest(body, { loadRemoteImages: false, warnings });
  const stripped = /<img src=""\s+alt="logo">/.test(out);
  const warned = warnings.some(w => /Stripped 1.*1\.1\.1\.1/.test(w) && /env LOAD_REMOTE_IMAGES=false/.test(w));
  check('loadRemoteImages:false strips public http(s) src',
    stripped && warned, { stripped, warned, out, warnings });
}

// 2. loadRemoteImages=true: public host passes; private host blocked.
{
  const body = `
    <img src="https://1.1.1.1/logo.png" alt="public">
    <img src="http://169.254.169.254/latest/meta-data/" alt="imds">
    <img src="http://10.0.0.5/internal" alt="rfc1918">
  `;
  const warnings = [];
  const out = await filterRemoteUrlsForTest(body, { loadRemoteImages: true, warnings });
  const publicKept = /https:\/\/1\.1\.1\.1\/logo\.png/.test(out);
  const imdsStripped = !/169\.254\.169\.254/.test(out);
  const rfc1918Stripped = !/10\.0\.0\.5/.test(out);
  const warned = warnings.some(w => /Stripped 2/.test(w) && /private\/internal/.test(w));
  check('loadRemoteImages:true keeps public, blocks private/IMDS',
    publicKept && imdsStripped && rfc1918Stripped && warned,
    { publicKept, imdsStripped, rfc1918Stripped, warned, out, warnings });
}

// 3. href=, background=, and CSS url(...) all covered.
{
  const body = `
    <a href="https://10.0.0.1/internal">click</a>
    <table background="https://192.168.1.1/bg.png"><tr><td>x</td></tr></table>
    <div style="background:url(https://172.16.0.5/bg.jpg)">x</div>
    <style>body { background: url('http://127.0.0.1/local.png'); }</style>
  `;
  const warnings = [];
  const out = await filterRemoteUrlsForTest(body, { loadRemoteImages: true, warnings });
  const hrefStripped = !/href="https:\/\/10\.0\.0\.1/.test(out) && /click<\/a>/.test(out);
  const bgAttrStripped = !/192\.168\.1\.1/.test(out) && /background=""/.test(out);
  const cssUrlStripped = !/172\.16\.0\.5/.test(out) && /url\(about:blank\)/.test(out);
  const styleBlockStripped = !/127\.0\.0\.1/.test(out);
  check('href=, background=, and CSS url(...) all filtered',
    hrefStripped && bgAttrStripped && cssUrlStripped && styleBlockStripped,
    { hrefStripped, bgAttrStripped, cssUrlStripped, styleBlockStripped, out });
}

// 4. data: and cid: URLs always pass through.
{
  const body = `
    <img src="data:image/png;base64,AAAA">
    <img src="cid:something@unresolved">
    <img src="https://10.1.2.3/private">
  `;
  const warnings = [];
  const out = await filterRemoteUrlsForTest(body, { loadRemoteImages: true, warnings });
  const dataKept = /data:image\/png;base64,AAAA/.test(out);
  const cidKept = /cid:something@unresolved/.test(out);
  const privateStripped = !/10\.1\.2\.3/.test(out);
  check('data: and cid: URLs always pass; only http(s) is gated',
    dataKept && cidKept && privateStripped,
    { dataKept, cidKept, privateStripped });
}

// 5. srcset with a private URL → entire srcset attribute stripped.
{
  const body = `<img srcset="https://1.1.1.1/a.png 1x, http://10.0.0.5/b.png 2x" src="https://1.1.1.1/a.png">`;
  const warnings = [];
  const out = await filterRemoteUrlsForTest(body, { loadRemoteImages: true, warnings });
  const srcsetGone = !/srcset=/.test(out);
  // The plain src to public host should still be there.
  const srcKept = /src="https:\/\/1\.1\.1\.1\/a\.png"/.test(out);
  check('srcset with private URL → attribute dropped, plain src kept',
    srcsetGone && srcKept, { srcsetGone, srcKept, out });
}

// 6. No URLs to filter → no warning, body unchanged.
{
  const body = `<p>just text</p><img src="data:image/png;base64,A">`;
  const warnings = [];
  const out = await filterRemoteUrlsForTest(body, { loadRemoteImages: true, warnings });
  check('no remote URLs → no-op, no warning',
    out === body && warnings.length === 0, { out, warnings });
}

// 7. loadRemoteImages=false MUST keep public hyperlinks intact (they're
// just clickable URLs — not auto-fetched). This is the P2 fix.
{
  const body = `
    <p>See <a href="https://1.1.1.1/docs">docs</a> for details.</p>
    <img src="https://1.1.1.1/logo.png" alt="logo">
  `;
  const warnings = [];
  const out = await filterRemoteUrlsForTest(body, { loadRemoteImages: false, warnings });
  // Public href survived even though loadRemoteImages=false (it doesn't
  // trigger an auto-fetch, just gives the consumer a clickable URL).
  const publicHrefKept = /<a href="https:\/\/1\.1\.1\.1\/docs">docs<\/a>/.test(out);
  // Public src to the same host was stripped (it WOULD auto-fetch).
  const publicSrcStripped = !/<img src="https:\/\/1\.1\.1\.1\/logo/.test(out);
  // Only ONE warning ("remote-fetch ... env LOAD_REMOTE_IMAGES=false"), no
  // "hyperlink host(s)" warning because the public hyperlink was kept.
  const fetchWarn = warnings.some(w => /remote-fetch URL host/.test(w));
  const noLinkWarn = !warnings.some(w => /hyperlink host/.test(w));
  check('loadRemoteImages=false keeps public href but strips public src',
    publicHrefKept && publicSrcStripped && fetchWarn && noLinkWarn,
    { publicHrefKept, publicSrcStripped, fetchWarn, noLinkWarn, out, warnings });
}

// 8. Private hyperlinks are still stripped regardless of loadRemoteImages
// (an LLM tool / agent might pre-fetch them — SSRF-adjacent risk).
{
  const body = `
    <a href="https://1.1.1.1/public">public</a>
    <a href="http://169.254.169.254/imds">imds</a>
    <a href="http://10.0.0.5/internal">internal</a>
  `;
  // With loadRemoteImages=true:
  {
    const warnings = [];
    const out = await filterRemoteUrlsForTest(body, { loadRemoteImages: true, warnings });
    const publicHrefKept = /href="https:\/\/1\.1\.1\.1\/public"/.test(out);
    const imdsHrefStripped = !/169\.254\.169\.254/.test(out) && /imds<\/a>/.test(out);
    const rfcHrefStripped = !/10\.0\.0\.5/.test(out) && /internal<\/a>/.test(out);
    const linkWarn = warnings.some(w => /hyperlink host/.test(w) && /private\/internal/.test(w));
    check('private hyperlinks stripped even with loadRemoteImages=true',
      publicHrefKept && imdsHrefStripped && rfcHrefStripped && linkWarn,
      { publicHrefKept, imdsHrefStripped, rfcHrefStripped, linkWarn, out, warnings });
  }
  // With loadRemoteImages=false, same: private hrefs stripped, public kept.
  {
    const warnings = [];
    const out = await filterRemoteUrlsForTest(body, { loadRemoteImages: false, warnings });
    const publicHrefKept = /href="https:\/\/1\.1\.1\.1\/public"/.test(out);
    const imdsHrefStripped = !/169\.254\.169\.254/.test(out);
    const rfcHrefStripped = !/10\.0\.0\.5/.test(out);
    check('hyperlink policy independent of loadRemoteImages',
      publicHrefKept && imdsHrefStripped && rfcHrefStripped,
      { publicHrefKept, imdsHrefStripped, rfcHrefStripped, out });
  }
}

if (fail) {
  console.error(`\n${fail} test(s) failed`);
  process.exit(1);
}
console.log('\nAll remote-policy tests passed');
