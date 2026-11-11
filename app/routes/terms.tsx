import type { MetaArgs } from "react-router";
import { canonicalMeta } from "../lib/seo";
import type { ReactNode } from "react";
import { Link, useLoaderData } from "react-router";
import { LegalDocument, type LegalSection } from "../components/common";
import { contactEmails, legal, type LegalDetails } from "../legal";
import { paths } from "../lib/shell";
import { legalLoader } from "../server/legal.server";

export const loader = legalLoader;

export function meta({ matches }: MetaArgs) {
  return [
    ...canonicalMeta(matches, "/terms"),
    { title: "Terms of Service · StreamBullets" },
    { name: "description", content: "The rules for using StreamBullets, posting content, and reporting problems." },
  ];
}

const mail: ReactNode = <a href={`mailto:${legal.contactEmail}`}>{legal.contactEmail}</a>;

const sections = (legal: LegalDetails): readonly LegalSection[] => [
  {
    id: "about",
    title: "About these terms",
    body: (
      <p>
        These terms are an agreement between you and {legal.operatorName}, an individual based in{" "}
        {legal.operatorCountry} who runs StreamBullets (“we”, “us”). By using StreamBullets you agree to them. Our{" "}
        <Link to="/privacy">Privacy Policy</Link> explains how we handle personal data.
      </p>
    ),
  },
  {
    id: "eligibility",
    title: "Who can use StreamBullets",
    body: (
      <p>
        You must be {legal.minimumAge} or older to create an account. You can read public pages without an account. If
        we learn that an account belongs to someone under {legal.minimumAge}, we delete it.
      </p>
    ),
  },
  {
    id: "accounts",
    title: "Your account",
    body: (
      <ul>
        <li>
          You sign in with Google, Twitch, TikTok, or Instagram (creator and business accounts). Your first sign-in
          creates your account, so there is no separate registration.
        </li>
        <li>Keep your sign-in account secure. You are responsible for what happens in your StreamBullets account.</li>
        <li>
          Accounts made with TikTok or Instagram have no email address. We cannot email you about them, and they cannot
          be administrator accounts.
        </li>
        <li>Use a display name that follows these terms and does not pretend to be someone else.</li>
        <li>One person, one account. Do not sell, share, or transfer accounts.</li>
      </ul>
    ),
  },
  {
    id: "streamers",
    title: "Streamer profiles",
    body: (
      <>
        <p>
          Streamer profiles are invite-only. You can ask to host from Host a community in the account menu.
          Administrators decide whether to approve or reject an application, and do not have to give a reason.
          Administrators can also create, change, or remove a streamer profile, or remove streamer access, for example
          if a profile breaks these terms or pretends to be someone else. A streamer controls the polls on their page
          and can remove content posted there.
        </p>
        <p>
          Administrators can <strong>freeze</strong> a streamer page: it stays public but nobody can post, vote, or
          change it. They can also <strong>suspend</strong> a page: it is hidden from everyone except its owner and
          administrators, and nothing is deleted. The owner sees a notice on the page with the reason. If email notices
          are turned on, the owner also gets an email. Either step can be reversed. To appeal, write to {mail}.
        </p>
      </>
    ),
  },
  {
    id: "content-rules",
    title: "Content rules",
    body: (
      <>
        <p>You are responsible for what you post. Do not post or do anything that:</p>
        <ul>
          <li>is illegal, or promotes or helps illegal activity;</li>
          <li>harasses, threatens, bullies, or encourages harm against anyone;</li>
          <li>is hateful toward people based on protected characteristics;</li>
          <li>is sexually explicit, or sexualizes minors in any way;</li>
          <li>shares someone else’s private information without permission;</li>
          <li>infringes copyright, trademark, or other rights;</li>
          <li>is spam, scams, malware, or misleading impersonation;</li>
          <li>manipulates votes, polls, or Mash Battle taps, for example with several accounts or automation;</li>
          <li>attacks, overloads, scrapes at scale, or tries to get around the security of the service.</li>
        </ul>
      </>
    ),
  },
  {
    id: "your-content",
    title: "Your content and our license",
    body: (
      <p>
        You keep ownership of what you post and upload. You give us a worldwide, non-exclusive, royalty-free license to
        host, store, copy, and display it, only to run StreamBullets and show it on the service, including on streamer
        pages and overlays. The license ends when the content is deleted, except for copies kept for a short time in
        backups. You confirm that you have the rights to post what you post.
      </p>
    ),
  },
  {
    id: "support-links",
    title: "Support links",
    body: (
      <p>
        Streamers can add up to four links to tip, donation, or membership pages on providers such as Ko-fi, Patreon, or
        Twitch. These are links only: StreamBullets never handles money and is not part of any payment. The provider’s
        own terms apply to what you do there. Each link must stay on its provider’s own domain. We may remove links that
        break these terms.
      </p>
    ),
  },
  {
    id: "ai-agents",
    title: "Automated agents and AI",
    body: (
      <p>
        AI agents and other automated tools may read public pages if they respect robots.txt and our rate limits. They
        may not create accounts, post, comment, vote, suggest topics, tap in a Mash Battle, or send reports. The one
        exception is the counter on the <Link to={paths.ai}>For AI agents</Link> page: an agent may send one vote a day.
        These rules may change as we add ways for declared AI agents to take part.
      </p>
    ),
  },
  {
    id: "reporting",
    title: "Reporting content and moderation",
    body: (
      <>
        <p>
          If you see content that is illegal or breaks these terms, use the <strong>Report</strong> button on the topic,
          poll, or comment. You can also email {mail}. Please include:
        </p>
        <ul>
          <li>a link to the content, or the streamer page and a description of where it is;</li>
          <li>why you think it is illegal or breaks these terms;</li>
          <li>your name and email, unless you report suspected child sexual abuse material;</li>
          <li>a statement that you believe the report is accurate and complete.</li>
        </ul>
        <p>What happens next:</p>
        <ul>
          <li>An administrator reviews the report in the admin area, without delay and without bias.</li>
          <li>
            We may remove the content, limit it, freeze or suspend a streamer page, remove streamer access, or close the
            account. We may also do nothing if the content is allowed.
          </li>
          <li>If you gave an email, we tell you our decision.</li>
          <li>
            If we act against your content or account, we tell you what we did and why, unless the law stops us or it
            would help an abuser. You can reply to {mail} to contest the decision, and we will look at it again.
          </li>
          <li>We may ignore people who send many clearly unfounded reports.</li>
          <li>We report threats to life or safety to the authorities when the law requires it.</li>
        </ul>
        <p>
          Single point of contact: {mail} is our point of contact for users and for authorities in the EU and elsewhere,
          including under the EU Digital Services Act. We accept messages in English.
        </p>
      </>
    ),
  },
  {
    id: "termination",
    title: "Ending your use",
    body: (
      <>
        <p>
          You can stop using StreamBullets at any time. To delete your account and everything linked to it, use{" "}
          <strong>account menu → Your data → Delete my account</strong>. You can download your data first.
        </p>
        <p>
          We can suspend or close your account, or remove content, if you break these terms, if the law requires it, or
          to protect users or the service. Where it is reasonable, we tell you first. We may also change or shut down
          the service. If we shut it down, we will give notice so you can download your data.
        </p>
      </>
    ),
  },
  {
    id: "disclaimers",
    title: "Disclaimers",
    body: (
      <p>
        StreamBullets is a free service provided “as is” and “as available”. We do not promise that it will always work,
        be error-free, or keep any particular feature. Content comes from users, and we do not check it before it
        appears. Poll results and opinions on the service are not advice.
      </p>
    ),
  },
  {
    id: "liability",
    title: "Limitation of liability",
    body: (
      <p>
        To the extent the law allows, we are not liable for indirect or consequential losses, lost profits, lost data,
        or content posted by others. Our total liability to you for any claim is limited to 50 euros or the amount you
        paid us in the last 12 months, whichever is greater. Nothing in these terms limits liability for death or
        personal injury caused by negligence, for fraud, or any other liability that the law does not allow us to limit.
        Nothing here takes away your rights as a consumer.
      </p>
    ),
  },
  {
    id: "law",
    title: "Governing law",
    body: (
      <p>
        These terms are governed by the laws of {legal.operatorCountry}. If you are a consumer, you also keep the
        protection of the mandatory laws of the country where you live, and you can bring a claim in your local courts.
      </p>
    ),
  },
  {
    id: "changes",
    title: "Changes to these terms",
    body: (
      <p>
        We may update these terms. We will change the effective date at the top, and for important changes we will show
        a notice on the site before they take effect. If you keep using StreamBullets after a change takes effect, the
        new terms apply. If you do not agree, you can delete your account.
      </p>
    ),
  },
  {
    id: "contact",
    title: "Contact",
    body: (
      <p>
        Email {mail} with questions about these terms, reports, or appeals. For general questions, write to{" "}
        <a href={`mailto:${contactEmails.support}`}>{contactEmails.support}</a>.
      </p>
    ),
  },
];

export default function Terms(): ReactNode {
  const legal = useLoaderData<typeof loader>();
  return (
    <LegalDocument
      title="Terms of Service"
      summary={
        <p>
          The short version: be {legal.minimumAge} or older, post only what you have the right to post, treat people
          with respect, and report anything that breaks the rules.
        </p>
      }
      legal={legal}
      sections={sections(legal)}
    />
  );
}
