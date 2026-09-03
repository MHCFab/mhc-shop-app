import type { Metadata } from "next";
import Link from "next/link";
import LegalPage, { Section } from "../components/LegalPage";

export const metadata: Metadata = {
  title: "Terms of Service — ShopWorks",
  description: "The agreement covering use of the ShopWorks shop management application.",
};

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service" effectiveDate="September 3, 2026">
      <p className="bg-amber-50 border border-amber-200 rounded-md p-4 text-sm text-amber-900">
        <strong>Pending legal review.</strong> This document describes how
        ShopWorks actually works and who operates it, but it has not yet been
        read by a lawyer. It will be reviewed before any shop outside MHC Fab
        signs up.
      </p>

      <p>
        These Terms of Service (the <strong>Terms</strong>) are an agreement
        between Mad House Customs LLC, a North Carolina limited liability company (
        <strong>we</strong>, <strong>us</strong>), and the business that signs
        up for ShopWorks (<strong>you</strong>, <strong>your shop</strong>). By
        creating an account, signing in, or letting anyone at your shop use
        ShopWorks, you agree to these Terms.
      </p>

      <Section n={1} heading="What ShopWorks is">
        <p>
          ShopWorks is a web application for running the day-to-day work of a
          fabrication or job shop: quoting and tracking jobs, tracking raw
          material, purchased parts and fabricated items, recording the hours
          your crew spends on each job, producing cost reports and invoices,
          and giving your customers a portal where they can see their jobs,
          place orders, and message your shop.
        </p>
        <p>
          ShopWorks is software, not a service that does the work for you. We
          do not manage your inventory, verify your numbers, or file anything
          on your behalf.
        </p>
      </Section>

      <Section n={2} heading="Accounts and who can use them">
        <p>
          Your shop gets one account, with one or more administrators. An
          administrator invites everyone else by email address: employees, who
          get access to the shop floor screens, and customer-portal users, who
          get access only to their own company&apos;s jobs and orders.
        </p>
        <p>
          You are responsible for who you invite and for what they do. When
          someone leaves your shop, remove their login. Deactivating a login
          inside the app is not the same as removing it. You are responsible
          for keeping passwords confidential and for telling us promptly at
          support@mhcfab.com if you believe an account has been compromised.
        </p>
        <p>
          Everyone who uses ShopWorks must be old enough to work lawfully for
          your business and at least 16 years old.
        </p>
      </Section>

      <Section n={3} heading="Your data stays yours">
        <p>
          Everything your shop puts into ShopWorks — jobs, customers, pricing,
          material, drawings, photos, time records — remains yours. We claim no
          ownership of it. We use it only to operate ShopWorks for you, to keep
          it working, and to do the things described in our{" "}
          <Link href="/privacy" className="text-blue-600 hover:underline">
            Privacy Policy
          </Link>
          .
        </p>
        <p>
          We do not sell your data. We do not share your shop&apos;s data with
          any other shop using ShopWorks, and the system is built so that one
          shop cannot read another shop&apos;s records.
        </p>
        <p>
          You may ask us for a copy of your data at any time while your
          subscription is active, and for 30 days after it ends. Ask at
          support@mhcfab.com.
        </p>
      </Section>

      <Section n={4} heading="Acceptable use">
        <p>You agree not to:</p>
        <ul className="list-disc pl-6 space-y-1">
          <li>
            try to reach data belonging to another shop, or probe, scan, or
            test the security of the system;
          </li>
          <li>
            copy, resell, sublicense, or rebrand ShopWorks as your own
            product, or reverse engineer it;
          </li>
          <li>
            upload anything unlawful, or anything you do not have the right to
            upload;
          </li>
          <li>
            use ShopWorks to send unsolicited email, or to store data you are
            not permitted to store;
          </li>
          <li>
            interfere with the operation of the service, or place an
            unreasonable load on it through automated means.
          </li>
        </ul>
      </Section>

      <Section n={5} heading="Trial, subscription, and payment">
        <p>
          New shops get a 14-day trial at no cost and without a card. At the
          end of the trial, continued use requires a paid subscription.
        </p>
        <p>
          Subscriptions are billed monthly in advance at the price shown when
          you subscribe. Fees are non-refundable except where the law requires
          otherwise. We may change prices with at least 30 days notice, which
          takes effect at your next renewal. Any applicable taxes are yours to
          pay.
        </p>
        <p>
          You can cancel at any time; cancellation takes effect at the end of
          the period you have already paid for.
        </p>
      </Section>

      <Section n={6} heading="What happens if you stop paying">
        <p>
          If a subscription lapses, your shop&apos;s access is locked — not
          deleted. Your data stays where it is, and paying restores access to
          it. We will keep a locked-out shop&apos;s data for at least 90 days
          before it becomes eligible for deletion, and we will email the
          account administrator before deleting anything.
        </p>
      </Section>

      <Section n={7} heading="Availability, backups, and support">
        <p>
          We work to keep ShopWorks available and we take regular backups, but
          we do not promise any particular level of uptime unless we have
          agreed one with you separately in writing. Maintenance, outages at
          our hosting providers, and problems outside our control will happen.
        </p>
        <p>
          <strong>
            Keep your own records of anything your business cannot afford to
            lose.
          </strong>{" "}
          Backups are a safety net, not a guarantee, and no backup system
          recovers everything in every circumstance.
        </p>
        <p>
          Support is provided by email at support@mhcfab.com during normal
          business hours, Monday through Friday, 7am to 4pm Eastern.
        </p>
      </Section>

      <Section n={8} heading="Numbers, costs, and estimates">
        <p>
          ShopWorks calculates costs, stock levels, margins, and invoice totals
          from what you and your crew enter. Those figures are a management
          tool. They are not accounting, tax, or legal advice, and they are not
          a substitute for your own books. Check anything you are going to act
          on — a quote you are sending, an invoice you are billing, a purchase
          you are making.
        </p>
      </Section>

      <Section n={9} heading="Suspension and termination">
        <p>
          We may suspend or terminate an account that is being used in breach
          of these Terms, that puts the service or other shops at risk, or that
          has gone unpaid. Where the circumstances allow it, we will tell you
          first and give you a chance to fix the problem.
        </p>
        <p>
          You may stop using ShopWorks at any time. Sections covering your
          data, confidentiality, disclaimers, liability, and governing law
          survive the end of this agreement.
        </p>
      </Section>

      <Section n={10} heading="Confidentiality">
        <p>
          Each of us may see information the other treats as confidential —
          your pricing and customer list on one side, how the software works on
          the other. Neither of us will disclose the other&apos;s confidential
          information except to people who need it to do this work and are
          bound to keep it confidential, or where the law requires disclosure.
        </p>
      </Section>

      <Section n={11} heading="Disclaimer">
        <p className="uppercase text-sm tracking-wide">
          ShopWorks is provided as is and as available. To the fullest extent
          permitted by law, we disclaim all warranties, express or implied,
          including any warranty of merchantability, fitness for a particular
          purpose, and non-infringement. We do not warrant that the service
          will be uninterrupted, error-free, or that the results it produces
          will be accurate.
        </p>
      </Section>

      <Section n={12} heading="Limit on what we owe you">
        <p className="uppercase text-sm tracking-wide">
          To the fullest extent permitted by law, neither party is liable for
          indirect, incidental, special, consequential, or punitive damages, or
          for lost profits, lost revenue, or lost data. Our total liability for
          any claim arising out of or relating to these Terms is limited to the
          amount you paid us for ShopWorks in the 12 months before the event
          giving rise to the claim.
        </p>
        <p>
          Nothing here limits liability that cannot be limited under applicable
          law.
        </p>
      </Section>

      <Section n={13} heading="Indemnity">
        <p>
          You will defend and indemnify us against third-party claims arising
          from the data you put into ShopWorks or from your use of the service
          in breach of these Terms.
        </p>
      </Section>

      <Section n={14} heading="Changes to these Terms">
        <p>
          We may update these Terms. If a change materially affects you, we
          will email the account administrator at least 30 days before it
          takes effect. Continuing to use ShopWorks after that means you accept
          the updated Terms. The effective date at the top of this page always
          shows the current version.
        </p>
      </Section>

      <Section n={15} heading="Governing law">
        <p>
          These Terms are governed by the laws of the State of North Carolina, without
          regard to its conflict of laws rules. Any dispute will be brought in
          the state or federal courts located in Iredell County, North Carolina, and both
          parties consent to that jurisdiction.
        </p>
      </Section>

      <Section n={16} heading="Contact">
        <p>
          Mad House Customs LLC
          <br />
          115 Scotsway Ct, Troutman, NC 28166
          <br />
          <a
            href="mailto:support@mhcfab.com"
            className="text-blue-600 hover:underline"
          >
            support@mhcfab.com
          </a>
        </p>
      </Section>
    </LegalPage>
  );
}
