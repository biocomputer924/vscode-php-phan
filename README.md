# PHP for Visual Studio Code (powered by Phan).

## Features

+ Warning and error diagnostics from Phan
+ Code completion
+ Type information and documentation on hover
+ Jump to definition

## Dependencies

+ PHP 7.2+
+ php-ast (Recommended)
+ pcntl (Recommended)

## Usage

This extension will detect the `.phan/config.php` file in your workspace and launch `phan`.  
See [Creating a Config File](https://github.com/phan/phan/wiki/Getting-Started#creating-a-config-file)

If not detected, the workspace root is analyzed.
