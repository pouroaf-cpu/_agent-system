import Link from 'next/link';
import React, { ButtonHTMLAttributes } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  href?: string;
  variant?: 'primary' | 'secondary';
}

export const Button: React.FC<ButtonProps> = ({ children, href, variant = 'primary', ...props }) => {
  const baseClasses = 'px-4 py-2 rounded focus:outline-none';
  const variants = {
    primary: 'bg-blue-500 text-white hover:bg-blue-700',
    secondary: 'border border-gray-300 text-black hover:bg-gray-100',
  };

  const classes = `${baseClasses} ${variants[variant]}`;

  if (href) {
    return (
      <Link href={href}>
        <button className={classes} {...props}>{children}</button>
      </Link>
    );
  }

  return (
    <button className={classes} {...props}>{children}</button>
  );
};
