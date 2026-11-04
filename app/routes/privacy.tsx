import type { ReactNode } from "react";
import { Link } from "react-router";
import { LegalDocument, type LegalSection } from "../components/common";
import { legal } from "../legal";

export function meta() {
  return [
    { title: "Privacy Policy · StreamBullets" },
    { name: "description", content: "What personal data StreamBullets collects, why, and how you control it." },
  ];
}

const mail: ReactNode = <a href={`mailto:${legal.contactEmail}`}>{legal.contactEmail}</a>;

const sections: readonly LegalSection[] = [
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
        <h3>From your sign-in provider (Google or Twitch)</h3>
        <ul>
          <li>Your display name and email address, and whether the provider verified the email.</li>
          <li>Your provider account ID and a link to your provider profile picture.</li>
          <li>
            Sign-in tokens from the provider. We store them encrypted and use them only to complete sign-in. We do not
            post to, or read anything else from, your Google or Twitch account.
          </li>
        </ul>
        <p>
          We do not download or show your provider profile picture. Your avatar on StreamBullets is empty until you
          upload one.
        </p>
        <h3>What you give us</h3>
        <ul>
          <li>Your display name if you change it, and any avatar image you upload.</li>
          <li>Topics, polls, comments, replies, votes, reactions, and likes.</li>
          <li>For streamers: your handle, page name, about text, avatar, and page background.</li>
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
        </ul>
        <p>
          We do not use analytics, advertising, or tracking tools, and we do not build profiles about you. We do not ask
          for sensitive data such as health, religion, or precise location.
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
                <td>Handle reports, moderate content, and enforce the Terms.</td>
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
        the details of reports.
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
            <strong>Google</strong> and <strong>Twitch</strong> handle sign-in. When you sign in, they learn that you
            use StreamBullets. Their own privacy policies apply to what they do.
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
          <strong>Your content</strong> stays until you, the page owner, or an administrator deletes it, or until you
          delete your account.
        </li>
        <li>
          <strong>Your account</strong> and everything linked to it stay until you delete the account. Deletion removes
          your profile, sessions, sign-in links, content, votes, reactions, uploaded images, streamer page, waitlist
          application, and reports.
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
            <strong>Settings → Your data → Download my data</strong> for a machine-readable JSON file.
          </li>
          <li>
            <strong>Rectification:</strong> change your display name, avatar, and streamer page in{" "}
            <Link to="/settings">Settings</Link>. Ask us to fix anything else.
          </li>
          <li>
            <strong>Erasure:</strong> use <strong>Settings → Your data → Delete my account</strong>. Deletion is
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
          For anything you cannot do yourself in Settings, email {mail} from the address on your account. We answer
          within one month. For complex requests we can extend this by two more months, and we will tell you why. We may
          ask you to confirm your identity.
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
          You can ask to know what we collect, use, and disclose; to delete it; and to correct it. Use Settings, or
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
          We use only cookies that are strictly necessary to sign you in and keep your account secure. We do not use
          analytics, advertising, or third-party tracking cookies. Because of this, the site does not show a cookie
          consent banner. If we ever want to add a cookie that is not strictly necessary, we will ask for your consent
          first.
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
                  <code>__Secure-stream-bullets.session_token</code>
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
            </tbody>
          </table>
        </div>
        <p>
          On local development servers the cookie names have no <code>__Secure-</code> prefix. On phones that ask for
          motion access, the home page stores <code>stream-bullets:tilt-declined</code> in your browser’s local storage
          if you refuse, so it does not ask again. It never leaves your device. You can clear it with your browser’s
          site data settings.
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
        Email {mail} for privacy questions, requests, or complaints. You can also read the{" "}
        <Link to="/terms">Terms of Service</Link>.
      </p>
    ),
  },
];

export default function Privacy(): ReactNode {
  return (
    <LegalDocument
      title="Privacy Policy"
      summary={
        <p>
          The short version: we collect what we need to run StreamBullets, we use only strictly necessary cookies, we
          never sell your data, and you can download or delete everything from Settings.
        </p>
      }
      sections={sections}
    />
  );
}
