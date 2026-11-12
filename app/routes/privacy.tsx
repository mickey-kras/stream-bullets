import { canonicalMeta } from "../lib/seo";
import type { ReactNode } from "react";
import { Link, useLoaderData, type MetaArgs } from "react-router";
import { LegalDocument, type LegalSection } from "../components/common";
import { contactEmails, legal, type LegalDetails } from "../legal";
import { paths } from "../lib/shell";
import { legalLoader } from "../server/legal.server";

export const loader = legalLoader;

export function meta({ matches }: MetaArgs) {
  return [
    ...canonicalMeta(matches, "/privacy"),
    { title: "Privacy Policy · StreamBullets" },
    { name: "description", content: "What personal data StreamBullets collects, why, and how you control it." },
  ];
}

const mail: ReactNode = <a href={`mailto:${legal.contactEmail}`}>{legal.contactEmail}</a>;
const support: ReactNode = <a href={`mailto:${contactEmails.support}`}>{contactEmails.support}</a>;

const sections = (legal: LegalDetails): readonly LegalSection[] => [
  {
    id: "who-we-are",
    title: "Who is responsible",
    body: (
      <>
        <p>
          StreamBullets is run by {legal.operatorName}, an individual based in {legal.operatorCountry} (“we”, “us”). We
          are the controller of the personal data described in this policy.
        </p>
        <p>
          Contact for all privacy questions and requests: {mail}. We have not appointed a data protection officer
          because the law does not require one for a service of this size.
        </p>
      </>
    ),
  },
  {
    id: "data-we-collect",
    title: "Data we collect",
    body: (
      <>
        <h3>From your sign-in provider (Google, Twitch, TikTok or Instagram)</h3>
        <ul>
          <li>Your display name, and your email address and whether the provider verified it.</li>
          <li>
            TikTok and Instagram do not share an email address. An account made with them has no contact email: we store
            an internal placeholder that is never shown and never receives mail. Such an account cannot be an
            administrator account.
          </li>
          <li>Your provider account ID and a link to your provider profile picture.</li>
          <li>
            Sign-in tokens from the provider. We store them encrypted and use them only to complete sign-in. We do not
            post to, or read anything else from, your Google, Twitch, TikTok or Instagram account.
          </li>
        </ul>
        <p>
          When you register with Google or Twitch, we try to import your provider profile picture as your initial
          avatar. If the import fails, we use the default Space explorer picture.
        </p>
        <p>You can replace or remove the photo in Your profile. Later sign-ins do not replace your chosen picture.</p>
        <h3>What you give us</h3>
        <ul>
          <li>Your display name if you change it, the preset picture you pick, and any avatar image you upload.</li>
          <li>
            Your age and terms acknowledgement: its time, the minimum age, and the policy versions you accepted. This
            private record is self-declared eligibility, not verified age. We do not collect your date of birth.
          </li>
          <li>
            Your language and your Accessibility &amp; display settings, if you choose them. Signed in, we keep them
            with your account; signed out, they stay in cookies in your browser.
          </li>
          <li>Topics, polls, comments, replies, votes, reactions, and likes.</li>
          <li>Mash Battle taps: how many times you tapped for your side, and whether you used assisted tapping.</li>
          <li>
            For streamers: your handle, page name, about text, page logo, avatar, page background, stream schedule,
            community cards, support links, and overlay settings.
          </li>
          <li>
            Ideas and bug reports on the official StreamBullets page. Browser and page details go with a bug report only
            if you tick the box to include them. They never include personal data.
          </li>
          <li>
            For the streamer waitlist: the channel links and note you send. Administrators see these with your name and
            email.
          </li>
          <li>Reports you make about content, and messages you send us.</li>
        </ul>
        <h3>Created when you use the service</h3>
        <ul>
          <li>
            Session records: a random session token, when it was created and expires, your IP address, and your
            browser’s user agent.
          </li>
          <li>
            Rate-limit counters. Sign-in limits use your IP address. Other limits use your account ID or a one-way hash
            of your IP address.
          </li>
          <li>
            Live poll connections. To cap connections per person, the live service counts open connections per IP
            address in memory. It does not store them.
          </li>
          <li>Technical metadata for uploaded images, such as type, size, and upload time.</li>
          <li>
            Votes on the <Link to={paths.ai}>For AI agents</Link> page: the vote, the day, and a keyed one-way hash
            (HMAC) of your IP address and that day. We never store the IP address itself, and hashes from different days
            cannot be linked to each other.
          </li>
          <li>
            Moderation records: when an administrator freezes or suspends a streamer page, or resolves reports, we
            record the action, the reason, an optional note, whether the owner was told, and which administrator acted.
          </li>
          <li>
            For administrators only: the security keys they register (public key, name, usage counter) and when each
            session last confirmed a key.
          </li>
        </ul>
        <p>
          Cloudflare Web Analytics measures visits and page performance. We also keep daily totals of landing-page
          clicks, completed sign-ins, streamer applications, and first votes and topic submissions for 90 days. These
          totals contain no account identifiers, IP addresses, page URLs, or user content. Random click receipts expire
          after one day. Two flags on your account prevent repeated first-vote and first-topic counts; they are included
          in your data export and removed with your account. We do not use advertising trackers or build advertising
          profiles.
        </p>
      </>
    ),
  },
  {
    id: "purposes",
    title: "Why we use it and our legal bases",
    body: (
      <>
        <p>Under the EU and UK GDPR we rely on these legal bases:</p>
        <div className="legal-table">
          <table>
            <thead>
              <tr>
                <th scope="col">Purpose</th>
                <th scope="col">Legal basis</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  Create and run your account, keep you signed in, show your content, count votes, run polls and
                  streamer pages, and review waitlist applications.
                </td>
                <td>Contract: we need it to give you the service you asked for (Art. 6(1)(b)).</td>
              </tr>
              <tr>
                <td>Keep the service secure: sessions, rate limits, abuse and spam prevention, and fixing errors.</td>
                <td>Legitimate interests in a safe, working service (Art. 6(1)(f)).</td>
              </tr>
              <tr>
                <td>
                  Handle reports, moderate content and streamer pages (freeze or suspend them), tell page owners about
                  decisions, and enforce the Terms.
                </td>
                <td>
                  Legitimate interests in protecting users and the service (Art. 6(1)(f)), and legal obligations where
                  they apply.
                </td>
              </tr>
              <tr>
                <td>
                  Answer lawful orders from authorities, keep records the law requires, and handle your privacy
                  requests.
                </td>
                <td>Legal obligation (Art. 6(1)(c)).</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          Where we rely on legitimate interests, we have weighed them against your rights. You can object at any time
          (see <a href="#your-rights">Your rights</a>). We do not rely on consent for any processing today. If we ever
          do, we will ask first and you can withdraw consent at any time.
        </p>
      </>
    ),
  },
  {
    id: "public",
    title: "What other people can see",
    body: (
      <p>
        Your display name, avatar, and the content you post are public on the streamer page where you post them.
        Streamer pages and overlays are public. Your email address, sign-in tokens, IP address, and session details are
        never shown publicly. Administrators can see the email address of people who apply to the streamer waitlist and
        the details of reports. A frozen streamer page stays public but read-only. A suspended page is hidden from
        everyone except its owner and administrators. Support links a streamer adds are public on their page. The AI
        interest counter shows only totals.
      </p>
    ),
  },
  {
    id: "recipients",
    title: "Who we share data with",
    body: (
      <>
        <p>We do not sell or rent your personal data, and we do not share it for advertising.</p>
        <ul>
          <li>
            <strong>Cloudflare, Inc.</strong> hosts the service as our processor. It runs the application (Workers), the
            database (D1), image storage (R2), live updates (Durable Objects), and the network that protects the site.
          </li>
          <li>
            <strong>Google</strong>, <strong>Twitch</strong>, <strong>TikTok</strong> and <strong>Instagram</strong>{" "}
            (Meta) handle sign-in. When you sign in, the provider you chose learns that you use StreamBullets. Their own
            privacy policies apply to what they do.
          </li>
          <li>
            Cloudflare Email Routing forwards mail you send to {contactEmails.support} or {legal.contactEmail}. If email
            notices are turned on, Cloudflare also sends a streamer an email when an administrator freezes or suspends
            their page.
          </li>
          <li>
            Support links take you to the provider’s own site, such as Ko-fi or Patreon. We send them nothing. What you
            do there is between you and that provider. StreamBullets never handles payments.
          </li>
          <li>Authorities, courts, or advisers, only when the law requires it or to protect rights and safety.</li>
          <li>A successor, if the service is ever transferred. We will tell you before that happens.</li>
        </ul>
      </>
    ),
  },
  {
    id: "transfers",
    title: "International transfers",
    body: (
      <p>
        Cloudflare runs a global network, so your data can be processed in countries outside your own, including the
        United States. For transfers out of the EU, EEA, UK, or Switzerland, we rely on Cloudflare’s data processing
        terms. These include the EU Standard Contractual Clauses, the UK addendum, and Cloudflare’s certification under
        the EU-US Data Privacy Framework and its UK and Swiss extensions. Contact us for a copy of the safeguards.
      </p>
    ),
  },
  {
    id: "retention",
    title: "How long we keep data",
    body: (
      <ul>
        <li>
          <strong>Sessions</strong> expire 7 days after your last activity, or when you sign out. An hourly task deletes
          expired sessions.
        </li>
        <li>
          <strong>Sign-in state</strong> (used to protect the sign-in redirect) expires after 10 minutes and is deleted
          after use or by the hourly task.
        </li>
        <li>
          <strong>Rate-limit records</strong> are deleted about 24 hours after their last use.
        </li>
        <li>
          <strong>AI interest votes</strong> are deleted after 30 days by the hourly task.
        </li>
        <li>
          <strong>Moderation records</strong> stay as an audit log so we can answer appeals and lawful requests. They
          hold the decision and its reason, not copies of your content.
        </li>
        <li>
          <strong>Your content</strong> stays until you, the page owner, or an administrator deletes it, or until you
          delete your account.
        </li>
        <li>
          <strong>Your account</strong> and everything linked to it stay until you delete the account. Deletion removes
          your profile, preferences, sessions, sign-in links, content, votes, reactions, Mash Battle taps, uploaded
          images, streamer page with its logo, schedule, community cards and support links, waitlist application,
          security keys, and reports.
        </li>
        <li>
          <strong>Reports</strong> stay open until an administrator decides. We keep a resolved report for one year as a
          moderation record, then delete it. If the author of reported content deletes their account, the report keeps
          only the decision, not a copy of their text.
        </li>
        <li>
          <strong>Backups:</strong> the database keeps point-in-time recovery history for up to 30 days. Deleted data
          leaves that history within 30 days. We do not restore deleted accounts from it.
        </li>
      </ul>
    ),
  },
  {
    id: "your-rights",
    title: "Your rights",
    body: (
      <>
        <p>Under the EU and UK GDPR, you have the right to:</p>
        <ul>
          <li>
            <strong>Access and portability:</strong> get a copy of your data. Use{" "}
            <strong>account menu → Your data → Download my data</strong> for a machine-readable JSON file.
          </li>
          <li>
            <strong>Rectification:</strong> change your display name and picture in{" "}
            <Link to={paths.profile}>Your profile</Link>, and your streamer page in Edit your page. Ask us to fix
            anything else.
          </li>
          <li>
            <strong>Erasure:</strong> use <strong>account menu → Your data → Delete my account</strong>. Deletion is
            immediate and cannot be undone. You can also delete single posts at any time.
          </li>
          <li>
            <strong>Restriction:</strong> ask us to pause use of your data while we check a complaint.
          </li>
          <li>
            <strong>Objection:</strong> object to processing based on legitimate interests.
          </li>
          <li>
            <strong>Withdraw consent:</strong> where we ask for consent, you can withdraw it at any time.
          </li>
          <li>
            <strong>Complain</strong> to a data protection supervisory authority, for example the one where you live or
            work. In the UK this is the Information Commissioner’s Office (ico.org.uk).
          </li>
        </ul>
        <p>
          For anything you cannot do yourself in your account, email {mail} from the address on your account. If your
          account has no email address (TikTok or Instagram sign-in), tell us your display name and we will check it
          another way. We answer within one month. For complex requests we can extend this by two more months, and we
          will tell you why. We may ask you to confirm your identity.
        </p>
        <p>We do not make decisions about you based solely on automated processing, and we do not profile you.</p>
      </>
    ),
  },
  {
    id: "california",
    title: "California privacy rights",
    body: (
      <>
        <p>
          If you live in California, the CCPA as amended by the CPRA gives you extra rights. In the last 12 months we
          collected these categories of personal information, from the sources and for the purposes described above:
        </p>
        <ul>
          <li>Identifiers: name, email address, account IDs, and IP address.</li>
          <li>
            Internet or other electronic activity: sessions, user agent, votes, reactions, and posts on the service.
          </li>
          <li>Audio, electronic, or visual information: images you upload.</li>
          <li>
            Sensitive personal information: account sign-in data (provider tokens). We use it only to sign you in and
            keep your account secure, not to infer anything about you.
          </li>
        </ul>
        <p>
          We do not sell your personal information and we do not share it for cross-context behavioral advertising. We
          have not done so in the last 12 months. We do not knowingly sell or share data of people under 16.
        </p>
        <p>
          You can ask to know what we collect, use, and disclose; to delete it; and to correct it. Use Your data, or
          email {mail}. An authorized agent can act for you with your signed permission. We verify requests by matching
          them to your account email and answer within 45 days. We will not treat you differently, charge you more, or
          give you a worse service because you used these rights.
        </p>
      </>
    ),
  },
  {
    id: "age",
    title: "Age limit and children",
    body: (
      <p>
        StreamBullets is not for anyone under {legal.minimumAge}. You must be {legal.minimumAge} or older to create an
        account. We do not knowingly collect data from children, including children under 13 as defined by the US COPPA.
        If we learn that someone under {legal.minimumAge} has an account, we delete the account and its data. If you
        think this has happened, email {mail}.
      </p>
    ),
  },
  {
    id: "cookies",
    title: "Cookies and local storage",
    body: (
      <>
        <p>
          We use only cookies that are strictly necessary to sign you in, keep your account secure, and remember the
          language and display settings you choose. We do not use analytics, advertising, or third-party tracking
          cookies. Because of this, the site does not show a cookie consent banner. If we ever want to add a cookie that
          is not strictly necessary, we will ask for your consent first.
        </p>
        <div className="legal-table">
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Purpose</th>
                <th scope="col">Duration</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <code>__Host-stream-bullets.session_token</code>
                </td>
                <td>Keeps you signed in. HTTP-only, so page scripts cannot read it.</td>
                <td>7 days, renewed while you use the site. Deleted when you sign out.</td>
              </tr>
              <tr>
                <td>
                  <code>__Secure-stream-bullets.state</code>
                </td>
                <td>
                  Protects the Google or Twitch sign-in redirect against forgery. The matching PKCE code verifier stays
                  on our server.
                </td>
                <td>5 minutes. Deleted when sign-in finishes.</td>
              </tr>
              <tr>
                <td>
                  Cloudflare security cookies, such as <code>__cf_bm</code>
                </td>
                <td>Set by Cloudflare only if its bot protection is active, to tell people from bots.</td>
                <td>Up to 30 minutes.</td>
              </tr>
              <tr>
                <td>
                  <code>sb_locale</code>
                </td>
                <td>Remembers the language you picked. Set only when you pick one.</td>
                <td>1 year.</td>
              </tr>
              <tr>
                <td>
                  <code>sb_prefs</code>
                </td>
                <td>
                  Remembers your Accessibility &amp; display settings, so text size and contrast apply before the page
                  shows. Set only when you change a setting.
                </td>
                <td>1 year.</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          On local HTTP development servers the cookie names have no <code>__Host-</code> or <code>__Secure-</code>{" "}
          prefix. On phones that ask for motion access, the home page stores <code>stream-bullets:tilt-declined</code>{" "}
          in your browser’s local storage if you refuse, so it does not ask again. Pages also keep{" "}
          <code>sb.lastContent</code> in session storage, the last streamer page you visited, for the back link. Neither
          leaves your device. You can clear them with your browser’s site data settings.
        </p>
      </>
    ),
  },
  {
    id: "security",
    title: "How we protect data",
    body: (
      <ul>
        <li>All traffic uses HTTPS. Session cookies are secure, HTTP-only, and limited to this site.</li>
        <li>Every change needs a valid session and must come from this site, which blocks cross-site attacks.</li>
        <li>Provider sign-in tokens are encrypted in the database.</li>
        <li>Owner and permission checks run on the server. Only administrators can review applications and reports.</li>
        <li>Rate limits slow down abuse. The general limiter keys on a one-way hash of your IP address.</li>
        <li>We do not log request bodies or identities, and platform logging is off by default.</li>
      </ul>
    ),
  },
  {
    id: "changes",
    title: "Changes to this policy",
    body: (
      <p>
        We will update the effective date at the top when this policy changes. For important changes we will show a
        notice on the site before they take effect. Earlier versions are available on request.
      </p>
    ),
  },
  {
    id: "contact",
    title: "Contact",
    body: (
      <p>
        Email {mail} for privacy questions, requests, or complaints. For anything else, write to {support}. You can also
        read the <Link to="/terms">Terms of Service</Link>.
      </p>
    ),
  },
];

export default function Privacy(): ReactNode {
  const legal = useLoaderData<typeof loader>();
  return (
    <LegalDocument
      title="Privacy Policy"
      summary={
        <p>
          The short version: we collect what we need to run StreamBullets, we use only strictly necessary cookies, we
          never sell your data, and you can download or delete everything from Your data in the account menu.
        </p>
      }
      legal={legal}
      sections={sections(legal)}
    />
  );
}
