import React from 'react';
import Head from 'next/head';
import Image from 'next/image';
import { Button } from '@/components/Button'; // Assuming you have a Button component

const Home: React.FC = () => {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center text-center">
      <Head>
        <title>DataShift</title>
        <meta name="description" content="Revolutionize your data management with DataShift." />
        <link rel="icon" href="/favicon.ico" />
      </Head>

      <main className="flex-1 flex flex-col items-center justify-center">
        <h1 className="text-4xl font-bold mb-4">Welcome to DataShift</h1>
        <p className="mb-8 text-lg">Your next-generation data management tool.</p>

        <div className="grid grid-cols-2 gap-4 w-full max-w-screen-md">
          <div className="flex flex-col items-start p-4 border rounded hover:bg-gray-100 transition duration-300">
            <h2 className="text-xl font-semibold mb-2">For Developers &rarr;</h2>
            <p className="mb-4">Explore the API and SDKs to integrate DataShift seamlessly into your workflows.</p>
            <Button href="/docs" variant="secondary">Docs</Button>
          </div>
          <div className="flex flex-col items-start p-4 border rounded hover:bg-gray-100 transition duration-300">
            <h2 className="text-xl font-semibold mb-2">For Teams &rarr;</h2>
            <p className="mb-4">Manage projects and collaborate with ease using DataShift's team features.</p>
            <Button href="/dashboard" variant="secondary">Dashboard</Button>
          </div>
        </div>
      </main>

      <footer className="flex items-center justify-center w-full h-24 border-t">
        <a
          href="https://vercel.com?utm_source=create-next-app&utm_medium=default-template&utm_campaign=create-next-app"
          target="_blank"
          rel="noopener noreferrer"
        >
          Powered by{' '}
          <span className="ml-2">
            <Image src="/vercel.svg" alt="Vercel Logo" width={72} height={16} />
          </span>
        </a>
      </footer>
    </div>
  );
};

export default Home;
