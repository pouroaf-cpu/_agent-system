// entire file content ...
import React from 'react';
import Head from 'next/head';
import Image from 'next/image';
import { Button } from '@/components/Button'; // Assuming you have a Button component
import styles from './index.module.css';

const Home: React.FC = () => {
  return (
    <div className={styles.container}>
      <Head>
        <title>DataShift</title>
        <meta name="description" content="Revolutionize your data management with DataShift." />
        <link rel="icon" href="/favicon.ico" />
      </Head>

      <main className={styles.main}>
        <h1 className={styles.title}>Welcome to DataShift</h1>
        <p className={styles.description}>Your next-generation data management tool.</p>

        <div className={styles.grid}>
          <div className={styles.card}>
            <h2>For Developers &rarr;</h2>
            <p>Explore the API and SDKs to integrate DataShift seamlessly into your workflows.</p>
            <Button href="/docs" variant="secondary">Docs</Button>
          </div>
          <div className={styles.card}>
            <h2>For Teams &rarr;</h2>
            <p>Manage projects and collaborate with ease using DataShift's team features.</p>
            <Button href="/dashboard" variant="secondary">Dashboard</Button>
          </div>
        </div>
      </main>

      <footer className={styles.footer}>
        <a
          href="https://vercel.com?utm_source=create-next-app&utm_medium=default-template&utm_campaign=create-next-app"
          target="_blank"
          rel="noopener noreferrer"
        >
          Powered by{' '}
          <span className={styles.logo}>
            <Image src="/vercel.svg" alt="Vercel Logo" width={72} height={16} />
          </span>
        </a>
      </footer>
    </div>
  );
};

export default Home;
