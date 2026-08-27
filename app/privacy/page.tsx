import type { Metadata } from "next";
import Link from "next/link";
import LegalPage, { Section } from "../components/LegalPage";

export const metadata: Metadata = {
  title: "Privacy Policy — ShopWorks",
  description: "How ShopWorks handles the information your shop puts into it.",
};

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy" effectiveDate="[EFFECTIVE DATE]">
      <p className="bg-amber-50 border border-amber-200 rounded-md p-4 text-sm text-amber-900">
        <strong>Draft.</strong> This document has not been reviewed by a
        lawyer. Every bracketed item below needs to be filled in, and the whole
        thing should be read by counsel before an outside shop signs up.
      </p>

      <p>
        This policy explains what information ShopWorks handles, why, and who
        else touches it. ShopWorks is operated by [LEGAL ENTITY NAME] (
        <strong>we</strong>, <strong>us</strong>). It covers the ShopWorks
        application at [WEBSITE], including the shop floor screens, the admin
        area, and the customer portal.
      </p>

      <Section n={1} heading="Two different kinds of information">
        <p>
          It matters which of these we are talking about, because our
          responsibilities are different.
        </p>
        <p>
          <strong>Your shop&apos;s working data</strong> — jobs, customers,
          quotes, material, drawings and photos, invoices, and the hours your
          crew logs. Your shop decides what goes in and what it is used for. We
          hold it and process it on your instructions, and for nothing else.
        </p>
        <p>
          <strong>Account and billing data</strong> — the shop name, the
          administrator&apos;s name and email, subscription status, and support
          correspondence. This we handle for our own purposes: running
          accounts, taking payment, and providing support.
        </p>
      </Section>

      <Section n={2} heading="What we collect">
        <ul className="list-disc pl-6 space-y-2">
          <li>
            <strong>People with logins.</strong> Name, email address, role
            (administrator, employee, or customer-portal user), which shop they
            belong to, and whether the login is active. Passwords are never
            visible to us — they are stored, hashed, by our authentication
            provider.
          </li>
          <li>
            <strong>Work records.</strong> Everything your shop enters: jobs,
            tasks, customers and their contact details, pricing and cost
            figures, inventory and material records, notes, uploaded photos and
            drawings, messages between your shop and its customers, and time
            entries showing which employee worked on what and for how long.
          </li>
          <li>
            <strong>Technical records.</strong> Standard server and application
            logs — IP address, browser type, pages requested, timestamps, and
            error details — kept to keep the service running and secure.
          </li>
          <li>
            <strong>Cookies.</strong> ShopWorks sets a session cookie so you
            stay signed in. That is what it is for. There are no advertising or
            tracking cookies, and we do not run third-party analytics that
            follow you across other sites.
          </li>
        </ul>
        <p>
          We do not ask for and do not want government identifiers, payment card
          numbers stored in the app, health information, or any other sensitive
          category of personal information. Please do not put it in job notes.
        </p>
      </Section>

      <Section n={3} heading="How we use it">
        <ul className="list-disc pl-6 space-y-1">
          <li>To provide ShopWorks and the features your shop turns on.</li>
          <li>To authenticate people and keep shops separated from each other.</li>
          <li>To send the emails the app depends on — invitations to new users and password resets.</li>
          <li>To diagnose faults, fix bugs, and keep the service secure.</li>
          <li>To bill for the subscription and to answer support requests.</li>
          <li>To send you service notices about outages, changes, or your account.</li>
        </ul>
        <p>
          We do not sell personal information, we do not share it for
          advertising, and we do not use your shop&apos;s working data to build
          products for anyone else.
        </p>
      </Section>

      <Section n={4} heading="Who else touches the data">
        <p>
          We use a small number of service providers to run ShopWorks. They act
          on our instructions and are bound to protect the data.
        </p>
        <ul className="list-disc pl-6 space-y-2">
          <li>
            <strong>Supabase</strong> — the database, login system, file
            storage for photos and drawings, and the delivery of invitation and
            password-reset emails. Data is stored in [REGION].
          </li>
          <li>
            <strong>Vercel</strong> — hosting and delivery of the application
            itself.
          </li>
          <li>
            <strong>[PAYMENT PROCESSOR]</strong> — subscription payments. Card
            details go to them directly and are never stored by ShopWorks.
          </li>
          <li>
            <strong>[EMAIL PROVIDER, IF SEPARATE]</strong> — sending
            application email.
          </li>
        </ul>
        <p>
          We will also disclose information where the law requires it, and, if
          our business is ever sold or merged, to the acquirer — in which case
          this policy continues to apply until you are told otherwise.
        </p>
        <p>
          <strong>One shop never sees another shop&apos;s data.</strong> Every
          record carries the shop it belongs to, and the database enforces that
          boundary on every read and write rather than relying on the
          application to remember.
        </p>
      </Section>

      <Section n={5} heading="How long we keep it">
        <ul className="list-disc pl-6 space-y-2">
          <li>
            Your shop&apos;s working data is kept for as long as the account is
            active, and for at least [90] days after a subscription ends, so
            that paying again restores everything.
          </li>
          <li>
            Time entries are removed automatically 30 days after the job they
            belong to has been invoiced. The totals stay on the job; the
            individual clock-in records do not.
          </li>
          <li>Technical logs are kept for [30-90] days.</li>
          <li>
            Account and billing records are kept for as long as the law
            requires, typically [7] years.
          </li>
        </ul>
        <p>
          An administrator can delete records inside the app at any time. To
          have an entire shop&apos;s data erased, write to [CONTACT EMAIL].
        </p>
      </Section>

      <Section n={6} heading="How it is protected">
        <ul className="list-disc pl-6 space-y-1">
          <li>All traffic to and from ShopWorks is encrypted in transit (HTTPS).</li>
          <li>Data is encrypted at rest by our hosting provider.</li>
          <li>
            Access rules are enforced in the database itself, per shop and per
            role, so a mistake in the application cannot expose another
            shop&apos;s records.
          </li>
          <li>Passwords are stored hashed and are never readable by us.</li>
          <li>
            Backups are taken automatically, and access to production systems is
            limited to the people who need it.
          </li>
        </ul>
        <p>
          No system is perfectly secure. If a breach affects your data, we will
          notify the affected shop administrators without undue delay and within
          any period the law requires.
        </p>
      </Section>

      <Section n={7} heading="If you are an employee or a customer of a shop">
        <p>
          If you log in as an employee or through a customer portal, the shop
          that invited you decides what is recorded about you and why. Requests
          to see, correct, or delete that information should go to that shop
          first. If you cannot reach them, write to us at [CONTACT EMAIL] and we
          will help where we are able to.
        </p>
        <p>
          Depending on where you live, you may have rights to access, correct,
          delete, or export your personal information, or to object to certain
          processing. We honor those rights as the law provides, and we will not
          treat you differently for exercising them.
        </p>
      </Section>

      <Section n={8} heading="Children">
        <p>
          ShopWorks is a tool for businesses and is not intended for anyone
          under 16. We do not knowingly collect information from children.
        </p>
      </Section>

      <Section n={9} heading="Changes to this policy">
        <p>
          We may update this policy. If a change materially affects how your
          information is handled, we will email the account administrator at
          least [30] days beforehand. The effective date at the top of this page
          always shows the current version.
        </p>
      </Section>

      <Section n={10} heading="Contact">
        <p>
          [LEGAL ENTITY NAME]
          <br />
          [MAILING ADDRESS]
          <br />
          <a
            href="mailto:[CONTACT EMAIL]"
            className="text-blue-600 hover:underline"
          >
            [CONTACT EMAIL]
          </a>
        </p>
        <p>
          See also our{" "}
          <Link href="/terms" className="text-blue-600 hover:underline">
            Terms of Service
          </Link>
          .
        </p>
      </Section>
    </LegalPage>
  );
}
